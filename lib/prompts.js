/**
 * prompts.js
 * System prompts for the ETH Lecture Copilot.
 * These prompts are used by all three AI providers (Gemini, Claude, OpenAI).
 */

/**
 * System prompt for lecture guide generation.
 * Takes a full transcript and returns structured JSON.
 */
const GUIDE_SYSTEM_PROMPT = `You are an expert academic assistant that converts lecture transcripts into structured study guides.

Your task: Read the provided lecture transcript and produce a JSON lecture guide. The guide divides the lecture into logical topic blocks (not fixed time intervals). Each block covers one coherent topic or subtopic.

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation, no preamble:

{
  "lecture_title": "string — inferred from content",
  "total_duration_seconds": number,
  "guide": [
    {
      "start_time": number (seconds),
      "end_time": number (seconds),
      "title": "string — concise topic title",
      "key_concepts": ["string", ...],
      "formulas": [
        {"label": "string", "latex": "string — valid LaTeX"}
      ],
      "definitions": [
        {"term": "string", "definition": "string"}
      ],
      "notes": "string — professor warnings, exam hints, cross-references, or empty string"
    }
  ]
}

RULES:
- Blocks must follow the logical flow of the lecture, not fixed intervals. One topic = one block.
- formulas: include EVERY formula, theorem, or equation mentioned. LaTeX must be valid and compilable by KaTeX. Use \\\\( \\\\) for inline, omit delimiters in the latex field itself.
- key_concepts: 2–6 bullet points per block, each a complete sentence or phrase.
- definitions: only include terms that are formally defined or explained in the lecture.
- notes: use for anything that doesn't fit above — "the professor emphasised this for the exam", "this relies on the definition from block 2", warnings about common mistakes, etc.
- Math formatting in textual fields (title, key_concepts, definitions.definition, notes): when mathematical notation appears, prefer LaTeX wrapped in $...$ (or $$...$$ for display when truly helpful).
- Readability formatting in textual fields: Markdown is allowed when it improves readability (for example #/## headings or short lists), but keep it lightweight and do NOT force markdown when plain text is clearer.
- Do NOT hallucinate. Only extract content that is actually present in the transcript.
- total_duration_seconds: use the last timestamp in the transcript.

EXAMPLE INPUT (2-block mini-lecture):
[00:00:00] Welcome. Today we cover graph traversal.
[00:00:30] BFS visits nodes level by level using a queue.
[00:01:00] The time complexity of BFS is O(V + E).
[00:02:00] Now, DFS uses a stack or recursion.
[00:02:30] DFS time complexity is also O(V + E).
[00:03:00] End of lecture.

EXAMPLE OUTPUT:
{"lecture_title":"Graph Traversal","total_duration_seconds":180,"guide":[{"start_time":0,"end_time":90,"title":"Breadth-First Search (BFS)","key_concepts":["BFS explores nodes level by level, visiting all neighbours before going deeper","A queue data structure drives the traversal order"],"formulas":[{"label":"BFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"BFS","definition":"Graph traversal algorithm that visits all neighbours of a node before visiting their neighbours"}],"notes":""},{"start_time":90,"end_time":180,"title":"Depth-First Search (DFS)","key_concepts":["DFS explores as far as possible along each branch before backtracking","Can be implemented with an explicit stack or via recursion"],"formulas":[{"label":"DFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"DFS","definition":"Graph traversal that goes deep along each path before exploring siblings"}],"notes":"Both BFS and DFS have the same asymptotic complexity O(V+E) but differ in traversal order and practical use cases."}]}

Now process the following transcript:`;

/**
 * Build the Q&A system prompt with embedded transcript and guide context.
 *
 * @param {string} transcriptText  — formatted transcript with timestamps
 * @param {object} guide           — parsed guide JSON object
 * @param {string} lectureTitle    — lecture title string
 * @returns {string}
 */
function buildQASystemPrompt(transcriptText, guide, lectureTitle) {
  const guideStr = JSON.stringify(guide, null, 2);
  return `You are a helpful study assistant for the ETH Zürich lecture: "${lectureTitle}".

You have access to the full lecture transcript and a structured guide. Answer the student's questions based ONLY on the lecture content — do not bring in outside knowledge unless explicitly asked.

When relevant, reference specific timestamps from the transcript (format: [HH:MM:SS]).
Keep answers concise, clear, and student-friendly. Use LaTeX for any mathematical notation (wrap in $...$ for inline or $$...$$ for display math).
Markdown formatting is allowed when it improves clarity (e.g., #/## headings, short bullet lists), but keep it minimal and do not force markdown when plain text is clearer.
If the answer is not in the lecture content, say so clearly rather than guessing.

--- LECTURE TRANSCRIPT ---
${transcriptText}

--- LECTURE GUIDE (structured summary) ---
${guideStr}
--- END OF CONTEXT ---`;
}

/**
 * Build the flashcards generation system prompt.
 *
 * @param {object} guide           — parsed guide JSON
 * @param {object} opts
 * @param {string|number} opts.count  — number or 'auto'
 * @param {string} opts.style         — 'recall' | 'definition' | 'mixed'
 * @param {boolean} opts.includeFormulas
 * @returns {string}
 */
function buildFlashcardsPrompt(guide, { count = 'auto', style = 'mixed', includeFormulas = true } = {}) {
  const countInstr = count === 'auto'
    ? 'Generate as many flashcards as needed to cover all key concepts, formulas, and definitions — typically 1–3 cards per block.'
    : `Generate exactly ${count} flashcards total, prioritising the most exam-relevant material.`;

  const styleInstr = {
    recall:     'Style: RECALL — fronts are questions ("What is…?", "How does…?", "When does…?"). Backs are complete, self-contained answers.',
    definition: 'Style: DEFINITION — fronts are a term or symbol. Backs give the full definition, formula, or explanation.',
    mixed:      'Style: MIXED — alternate freely between recall questions and definition cards. Choose the style that best suits each concept.'
  }[style] || 'Style: MIXED — alternate between recall questions and definition cards.';

  const formulaInstr = includeFormulas
    ? 'Include important formulas: put the label / name on the front, the LaTeX formula on the back (wrap in $$...$$). Also include verbal understanding.'
    : 'Skip standalone formula cards. Only reference formulas inline when needed to explain a concept.';

  return `You are an expert academic assistant creating Anki-style flashcards from a lecture guide.

${countInstr}

${styleInstr}

${formulaInstr}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "flashcards": [
    {
      "front": "string — question, term, or prompt (plain text or LaTeX in $...$)",
      "back": "string — complete answer or explanation (plain text or LaTeX in $...$)"
    }
  ]
}

RULES:
- Each card must be self-contained and answerable without seeing the lecture.
- Fronts must be specific and unambiguous — never "What is it?" without context.
- Backs must be concise but complete — 1–4 sentences or a formula.
- Do NOT duplicate cards or create trivially similar variations.
- Cover the full lecture; do not over-index on the first few blocks.
- LaTeX in $...$ for inline math, $$...$$ for display equations on cards.
- Do NOT hallucinate. Only use content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the practice quiz system prompt.
 *
 * @param {object} guide
 * @param {object} opts
 * @param {number} opts.count        — number of questions
 * @param {string} opts.type         — 'mc' | 'sa' | 'mixed'
 * @returns {string}
 */
function buildQuizPrompt(guide, { count = 10, type = 'mixed' } = {}) {
  const typeInstr = {
    mc:    'ALL questions must be multiple-choice (4 options each).',
    sa:    'ALL questions must be short-answer (open-ended; expected answer 1–3 sentences).',
    mixed: 'Mix multiple-choice (MC) and short-answer (SA) questions roughly 50/50.'
  }[type] || 'Mix multiple-choice and short-answer questions.';

  return `You are an expert academic assistant creating a practice quiz from a lecture guide.

Generate exactly ${count} quiz questions that test understanding of the lecture material.
${typeInstr}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "questions": [
    {
      "type": "mc",
      "question": "string",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0,
      "explanation": "string — why the correct answer is right and the others are wrong"
    },
    {
      "type": "sa",
      "question": "string",
      "answer": "string — model answer (1–3 sentences)",
      "explanation": "string — key points the answer should contain"
    }
  ]
}

RULES:
- For MC: exactly 4 options labelled "A) …", "B) …", "C) …", "D) …". "correct" is the 0-based index.
- For SA: "answer" is the model answer; "explanation" lists the key points.
- Questions must cover the full lecture — do not cluster in early blocks only.
- Vary Bloom's taxonomy: recall, application, analysis.
- Distractors in MC questions must be plausible — no obviously wrong options.
- Use LaTeX ($...$) for any math in questions or answers.
- Do NOT hallucinate. Only test content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the exam question generation system prompt.
 *
 * @param {object} guide
 * @param {string[]} selectedBlockTitles  — block titles in scope (empty = whole guide)
 * @param {object} opts
 * @param {string} opts.difficulty     — 'easy' | 'medium' | 'hard' | 'mixed'
 * @param {string} opts.depth          — 'surface' | 'deep' | 'research'
 * @param {string} opts.scope          — 'narrow' | 'broad' | 'cross-topic'
 * @param {string} opts.answerLength   — 'short' | 'medium' | 'long'
 * @param {string} opts.format         — 'open' | 'mc' | 'proof' | 'mixed'
 * @param {boolean} opts.questionsPerBlock — if true, generate per block; else generate total
 * @param {number} opts.count          — total number of questions (ignored if questionsPerBlock=true)
 * @returns {string}
 */
function buildExamQuestionsPrompt(guide, selectedBlockTitles = [], {
  difficulty = 'mixed',
  depth = 'deep',
  scope = 'broad',
  answerLength = 'medium',
  format = 'open',
  questionsPerBlock = false,
  count = 5
} = {}) {
  const scopeStr = selectedBlockTitles.length > 0
    ? `Focus ONLY on these blocks: ${selectedBlockTitles.map(t => `"${t}"`).join(', ')}.`
    : 'Cover the full guide — all blocks contribute.';

  const difficultyInstr = {
    easy:   'EASY difficulty — test basic recall and direct application of definitions.',
    medium: 'MEDIUM difficulty — test understanding, pattern recognition, and straightforward application.',
    hard:   'HARD difficulty — test deep analysis, synthesis across topics, and non-trivial applications.',
    mixed:  'MIXED difficulty — include a spread of easy, medium, and hard questions.'
  }[difficulty] || 'MIXED difficulty.';

  const depthInstr = {
    surface:  'Surface depth — questions require recall and simple application.',
    deep:     'Deep depth — questions require genuine understanding, not just memorisation.',
    research: 'Research depth — questions require critical analysis, comparison of approaches, or synthesis.'
  }[depth] || 'Deep depth.';

  const formatInstr = {
    open:   'ALL questions must be open-ended (essay / written answer).',
    mc:     'ALL questions must be multiple-choice (4 options).',
    proof:  'ALL questions must require a proof or derivation.',
    mixed:  'Mix question formats: open-ended, multiple-choice (4 options), and proof/derivation questions.'
  }[format] || 'Mixed formats.';

  const answerLengthInstr = {
    short:  'Expected answer length: SHORT — 1–3 sentences or a formula.',
    medium: 'Expected answer length: MEDIUM — 1 paragraph or a moderate derivation.',
    long:   'Expected answer length: LONG — multi-paragraph essay or a full proof.'
  }[answerLength] || 'Expected answer length: MEDIUM.';

  const countInstr = questionsPerBlock
    ? 'Generate 1–2 questions per block, prioritising blocks most likely to appear on exams.'
    : `Generate exactly ${count} questions total.`;

  return `You are an expert university professor designing exam questions from a lecture guide.

${countInstr}
${scopeStr}

${difficultyInstr}
${depthInstr}
${formatInstr}
${answerLengthInstr}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "questions": [
    {
      "question": "string",
      "type": "open" | "mc" | "proof",
      "difficulty": "easy" | "medium" | "hard",
      "relevant_block": "string — title of the most relevant guide block",
      "sample_answer": "string — model answer or proof sketch",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0
    }
  ]
}

RULES:
- For "mc" type: include "options" (4 choices) and "correct" (0-based index). Omit these fields for other types.
- "sample_answer" must be a complete, exam-grade answer — not a hint or summary.
- Questions must reflect what a university professor would realistically ask on a written exam.
- Do NOT ask trivial "name a concept" questions — require understanding.
- LaTeX ($...$) for any math in questions or answers.
- Do NOT hallucinate. Only test content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the cross-lecture exam prediction system prompt.
 *
 * @param {Array<{lectureTitle: string, guide: object}>} lectures
 * @param {object} opts  — same shape as buildExamQuestionsPrompt opts
 * @returns {string}
 */
function buildCrossLecturePredictionPrompt(lectures, {
  difficulty = 'mixed',
  depth = 'deep',
  scope = 'broad',
  answerLength = 'medium',
  format = 'open',
  count = 5
} = {}) {
  const lectureList = lectures.map((l, i) => `Lecture ${i + 1}: "${l.lectureTitle}"`).join('\n');

  const difficultyInstr = {
    easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', mixed: 'MIXED'
  }[difficulty] || 'MIXED';

  const formatInstr = {
    open: 'open-ended (essay / written answer)',
    mc:   'multiple-choice (4 options)',
    proof: 'proof or derivation',
    mixed: 'mixed (open-ended, multiple-choice, and proof/derivation)'
  }[format] || 'mixed formats';

  const answerLengthInstr = {
    short: 'SHORT (1–3 sentences)', medium: 'MEDIUM (1 paragraph)', long: 'LONG (multi-paragraph)'
  }[answerLength] || 'MEDIUM';

  return `You are an expert university professor who has seen the material for a full course and is predicting likely exam questions.

You are given guides for the following lectures:
${lectureList}

Based on recurring themes, key concepts that appear across multiple lectures, and topics that are typically exam-relevant in this subject area, predict the most likely exam questions.

Generate exactly ${count} high-probability exam questions.
Difficulty: ${difficultyInstr}
Depth: ${depth}
Format: ${formatInstr}
Expected answer length: ${answerLengthInstr}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "exam_topics": [
    {
      "topic": "string — recurring theme or cross-lecture concept",
      "confidence": "high" | "medium" | "low",
      "rationale": "string — why this is likely to appear on the exam",
      "source_lectures": ["string", ...]
    }
  ],
  "questions": [
    {
      "question": "string",
      "type": "open" | "mc" | "proof",
      "difficulty": "easy" | "medium" | "hard",
      "source_lectures": ["string", ...],
      "sample_answer": "string — model answer or proof sketch",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0
    }
  ]
}

RULES:
- "exam_topics": list the 3–6 most exam-likely themes ACROSS the selected lectures.
- "confidence" reflects how strongly the topic is emphasised across lectures.
- "rationale" must explain specifically why this topic is exam-relevant (e.g., "appears in 3 lectures", "professor marked as exam-relevant", "foundational theorem").
- Questions must span multiple lectures where possible — cross-topic synthesis is the highest-value signal.
- For "mc" type: include "options" and "correct" (0-based index). Omit for other types.
- LaTeX ($...$) for any math.
- Do NOT hallucinate. Only reference content present in the provided guides.

The lecture guides (as JSON array) follow:`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    GUIDE_SYSTEM_PROMPT,
    buildQASystemPrompt,
    buildFlashcardsPrompt,
    buildQuizPrompt,
    buildExamQuestionsPrompt,
    buildCrossLecturePredictionPrompt
  };
}
