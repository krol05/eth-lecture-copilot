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
  "guide_title": "string - concise topic title for this specific guide",
  "total_duration_seconds": number,
  "guide": [
    {
      "start_time": number (seconds),
      "end_time": number (seconds),
      "title": "string — concise topic title",
      "key_concepts": [{"label": "string", "lead": "string", "body": "string"}, ...],
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
- guide_title: create a short, specific title for the main topic of this guide, e.g. "Introduction to Caches". Do NOT use the course name unless the lecture is genuinely a course overview.
- formulas: include EVERY formula, theorem, or equation mentioned. LaTeX must be valid and compilable by KaTeX. Use \\\\( \\\\) for inline, omit delimiters in the latex field itself.
- key_concepts: 3-6 compact structured bullets per block when the transcript supports it. Each item must be an object with label, lead, and body. label is a 1-3 word pill under 24 characters. lead is a short precise takeaway, roughly 4-12 words. body is 1-2 short supporting sentences. Never output key_concepts as strings.
- definitions: only include terms that are formally defined or explained in the lecture.
- notes: use for anything that doesn't fit above — "the professor emphasised this for the exam", "this relies on the definition from block 2", warnings about common mistakes, etc.
- Math formatting in textual fields (title, key_concepts, definitions.definition, notes): wrap every mathematical expression in LaTeX delimiters, using $...$ inline or $$...$$ for display. Never output raw math such as e^{2t}, t^m, y'', \\sin(t), or \\omega = 1 without delimiters.
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
{"lecture_title":"Graph Traversal","guide_title":"Breadth-First and Depth-First Search","total_duration_seconds":180,"guide":[{"start_time":0,"end_time":90,"title":"Breadth-First Search (BFS)","key_concepts":["BFS explores nodes level by level, visiting all neighbours before going deeper","A queue data structure drives the traversal order"],"formulas":[{"label":"BFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"BFS","definition":"Graph traversal algorithm that visits all neighbours of a node before visiting their neighbours"}],"notes":""},{"start_time":90,"end_time":180,"title":"Depth-First Search (DFS)","key_concepts":["DFS explores as far as possible along each branch before backtracking","Can be implemented with an explicit stack or via recursion"],"formulas":[{"label":"DFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"DFS","definition":"Graph traversal that goes deep along each path before exploring siblings"}],"notes":"Both BFS and DFS have the same asymptotic complexity O(V+E) but differ in traversal order and practical use cases."}]}

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
 * Targets ETH graduate-level rigour: formal definitions, theorem statements,
 * proof sketches, and precise mathematical notation.
 *
 * @param {object} guide           — parsed guide JSON
 * @param {object} opts
 * @param {string|number} opts.count  — number or 'auto'
 * @param {string} opts.style         — 'recall' | 'definition' | 'mixed'
 * @param {boolean} opts.includeFormulas
 * @returns {string}
 */
const FLASHCARD_TYPE_LABELS = {
  recall: 'Recall: active-retrieval questions that ask the student to remember or explain one important idea.',
  definition: 'Definition: precise cards for terms, concepts, principles, people, events, methods, classifications, or named results.',
  concept: 'Concept: cards that test the core intuition, purpose, importance, or meaning of an idea beyond its wording.',
  application: 'Application: cards that ask which idea, rule, method, or framework applies to a small scenario and why.',
  comparison: 'Comparison: cards that distinguish two nearby ideas, cases, methods, schools of thought, theories, or categories.',
  process: 'Process: cards that test ordered steps, stages, mechanisms, workflows, derivations, timelines, or argument structure.',
  cause_effect: 'Cause/effect: cards that test why something happens, what follows from it, or how one factor changes another.',
  example: 'Example: cards that connect an abstract idea to a concrete example, case, counterexample, symptom, source, dataset, text, or situation.',
  misconception: 'Misconception: cards that target likely confusions, exceptions, boundary cases, false friends, or common mistakes.',
  formula_rule: 'Formula/rule: cards for formulas, laws, rules, principles, constraints, notation, or decision criteria, including when they apply.'
};

function normalizeFlashcardTypeSelection(cardTypes) {
  const raw = Array.isArray(cardTypes) ? cardTypes : [cardTypes || 'auto'];
  const cleaned = raw.map(v => String(v || '').trim()).filter(Boolean);
  if (!cleaned.length || cleaned.some(v => v.toLowerCase() === 'auto')) return ['auto'];
  const allowed = new Set(Object.keys(FLASHCARD_TYPE_LABELS));
  const selected = [...new Set(cleaned.filter(v => allowed.has(v)))];
  return selected.length ? selected : ['auto'];
}

function buildFlashcardTypeInstructions(cardTypes, includeFormulas) {
  const selected = normalizeFlashcardTypeSelection(cardTypes);
  const formulaPolicy = includeFormulas
    ? 'Formula cards are allowed and encouraged when formulas, theorem statements, or notation are central to the lecture.'
    : 'Do not create standalone formula cards; mention formulas only when needed inside another selected card type.';

  if (selected.includes('auto')) {
    return `CARD TYPE SELECTION:
- Auto mode is active. Choose the best mixed set for this guide.
- Use the full universal card palette when useful: recall, definition, concept, application, comparison, process, cause_effect, example, misconception, and formula_rule.
- Prefer recall/concept cards for main ideas, definition cards for exact terms, application/example cards for transfer, comparison cards for similar ideas, process cards for sequences, cause_effect cards for mechanisms, misconception cards for common traps, and formula_rule cards for rules or notation.
- Do not force every type. Let the lecture content decide the mix.
- ${formulaPolicy}`;
  }

  const selectedLines = selected.map(t => `- ${t}: ${FLASHCARD_TYPE_LABELS[t]}`).join('\n');
  return `CARD TYPE SELECTION:
Use ONLY these selected card types unless a formula card is required by the formula setting:
${selectedLines}
- ${formulaPolicy}`;
}

function buildFlashcardsPrompt(guide, { count = 'auto', style = 'mixed', cardTypes = null, includeFormulas = true, language = '' } = {}) {
  const countInstr = count === 'auto'
    ? 'Generate as many flashcards as needed to cover the important concepts, terms, relationships, examples, methods, and conclusions thoroughly — typically 2–4 cards per guide block.'
    : `Generate exactly ${count} flashcards total, prioritising the most useful and study-relevant material.`;

  const typeSelection = cardTypes == null
    ? (style && style !== 'mixed' ? [style] : ['auto'])
    : cardTypes;
  const typeInstr = buildFlashcardTypeInstructions(typeSelection, includeFormulas);

  const formulaInstr = includeFormulas
    ? 'Include formula and theorem cards: put the theorem name or formula label on the front; the back must give the full formal statement in LaTeX (wrap equations in $$...$$), including all hypotheses, quantifiers, and a one-sentence intuition. Also include any important special cases or edge conditions.'
    : 'Skip standalone formula cards. Reference formulas inline only when essential to understanding a concept.';

  const langInstr = language
    ? `\n\nLANGUAGE: Write ALL natural-language content (front and back of every card) in ${language}. Keep JSON keys, LaTeX, and technical notation unchanged.`
    : `\n\nLANGUAGE: Match the language of the guide content. Do not switch to English unless the guide is in English. Keep JSON keys, LaTeX, and technical notation unchanged.`;

  return `You are an expert ETH Zürich professor creating Anki-style flashcards from a graduate-level lecture guide.${langInstr}

${countInstr}

${typeInstr}

${formulaInstr}

TARGET AUDIENCE: Students preparing for exams, assignments, discussions, or long-term mastery. Cards must be useful for real study: they should test genuine understanding and retrieval, not surface-level recognition.

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "flashcards": [
    {
      "front": "string — precise question, term, or theorem name (plain text or LaTeX in $...$)",
      "back": "string — complete rigorous answer (plain text with LaTeX in $...$ inline or $$...$$ for displayed equations)",
      "card_type": "recall | definition | concept | application | comparison | process | cause_effect | example | misconception | formula_rule | other",
      "source_block_title": "string — exact guide block title this card came from, or empty string",
      "source_time_range": "string — source time range in clock format such as 12:04-18:30 or 1:02:04-1:08:30, never raw seconds, or empty string",
      "tags": ["string", "..."],
      "reference": "string — lecture/block/formula/theorem reference, or empty string",
      "study_note": "string — brief note about why this card matters or a common mistake, or empty string"
    }
  ]
}

RULES:
- Do NOT generate a deckTitle. The guide already has a guide_title field used for history, exports, and Anki grouping.
- Every card must be self-contained and fully answerable without seeing the lecture.
- Every card must be atomic: test exactly one concept, term, relationship, distinction, process step, example, cause, consequence, or application.
- Never make broad paragraph cards that require recalling many unrelated facts at once.
- Fronts must be specific and unambiguous — never "What is it?" or "Explain X" without all necessary context on the front.
- Backs must be precise, complete, and compact:
  - Recall cards: answer the question directly, then include the key reason, consequence, example, or distinction when that is needed for understanding.
  - Definition cards: identify the term or object precisely, give the essential defining features, and include context that prevents confusion with similar terms.
  - Concept cards: explain the intuition, purpose, or importance of one idea.
  - Application cards: ask the learner to choose or use an idea in a small scenario.
  - Comparison cards: make the learner distinguish similar ideas, cases, or methods.
  - Process cards: include the ordered step, stage, decision rule, or purpose being tested.
  - Cause/effect cards: test why something happens or what follows from it.
  - Example cards: connect an abstract idea to a concrete case, source, situation, or counterexample.
  - Misconception cards: target likely confusions, exceptions, or boundary cases.
  - Formula/rule cards: state what each symbol or condition means and when the rule applies.
  - Argument cards: test one waypoint, assumption, move, or conclusion at a time; avoid putting an entire long argument on one card.
- Do NOT produce trivially similar variations of the same card.
- Cover the ENTIRE guide proportionally — do not over-index on the first few blocks.
- Use $...$ for inline math and $$...$$ for displayed equations in backs.
- Use card_type values exactly from the schema. Use "other" only if no listed type fits.
- tags should be short lowercase slugs, e.g. "definition", "key-concept", "week-3", "case-study". Do not include spaces in tags.
- source_block_title and source_time_range should point back to the most relevant guide block whenever possible.
- Strong general card patterns to include where relevant:
  * "What is [term/concept], and what distinguishes it from [nearby concept]?"
  * "Why does [claim/process/event/result] matter?"
  * "What are the main steps or stages of [process/method/argument]?"
  * "What assumption, condition, or context is required for [claim/formula/rule]?"
  * "Given [small scenario/example], which concept applies and why?"
- Do NOT hallucinate. Only use content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the practice quiz system prompt.
 * Targets ETH exam style: multi-part problems, formal statements, proof tasks.
 *
 * @param {object} guide
 * @param {object} opts
 * @param {number} opts.count        — number of questions
 * @param {string} opts.type         — 'mc' | 'sa' | 'mixed'
 * @returns {string}
 */
function buildQuizPrompt(guide, { count = 10, type = 'mixed', language = '' } = {}) {
  const typeInstr = {
    mc:    'ALL questions must be multiple-choice (4 options each). MC distractors must be carefully crafted plausible wrong answers that reflect common student mistakes, boundary-case confusions, or off-by-one errors — never obviously wrong.',
    sa:    'ALL questions must be short-answer or short-proof questions (1–4 sentence or equation answer expected). Questions should require the student to recall, derive, or briefly justify — not merely identify.',
    mixed: 'Mix multiple-choice (MC) and short-answer/proof (SA) questions roughly 50/50. For MC, distractors must reflect real misconceptions. For SA, require precise statements or derivations.'
  }[type] || 'Mix multiple-choice and short-answer questions with rigorous distractors.';

  const langInstr = language
    ? `\n\nLANGUAGE: Write ALL natural-language content (questions, options, answers, explanations) in ${language}. Keep JSON keys, LaTeX, and technical notation unchanged.`
    : `\n\nLANGUAGE: Match the language of the guide content. Do not switch to English unless the guide is in English.`;

  return `You are an ETH Zürich professor writing a closed-book practice exam for a graduate-level course.${langInstr}

Generate exactly ${count} questions that rigorously test mastery of the lecture material.
${typeInstr}

TARGET AUDIENCE: ETH students who have attended the lecture and are preparing for the written exam. Questions should reflect ETH exam standards — expect students to reason formally, apply theorems, and justify their answers.

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "questions": [
    {
      "type": "mc",
      "question": "string",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0,
      "explanation": "string — why the correct answer is right AND why each wrong answer is wrong"
    },
    {
      "type": "sa",
      "question": "string",
      "answer": "string — complete model answer with full justification",
      "explanation": "string — key points and common mistakes to watch for"
    }
  ]
}

RULES:
- For MC: exactly 4 options labelled "A) …", "B) …", "C) …", "D) …". "correct" is the 0-based index. Distractors must be plausible — no trivially wrong options.
- For SA: "answer" is the full model answer (may include LaTeX equations); "explanation" lists required key points.
- Questions must cover the FULL lecture proportionally — do not cluster in early blocks only.
- Vary Bloom's taxonomy across the question set:
  * Recall: "State the definition / theorem of …"
  * Application: "Apply [algorithm/method] to [specific instance]"
  * Analysis: "What happens to [X] when [condition changes]? Justify formally."
  * Synthesis/Proof: "Show that … / Prove or disprove …"
- Use LaTeX ($...$) for all math in questions and answers.
- Multi-part questions are encouraged: use (a), (b), (c) sub-questions when a concept has multiple testable aspects.
- Do NOT ask questions with "yes/no" answers or purely definitional recall — require reasoning.
- Do NOT hallucinate. Only test content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the exam question generation system prompt.
 * Targets ETH written exam style with formal proofs and multi-part problems.
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
  count = 5,
  language = ''
} = {}) {
  const scopeStr = selectedBlockTitles.length > 0
    ? `Focus ONLY on these blocks: ${selectedBlockTitles.map(t => `"${t}"`).join(', ')}.`
    : 'Cover the full guide — all blocks contribute.';

  const difficultyInstr = {
    easy:   'EASY difficulty — test direct recall of definitions and straightforward application of stated theorems. The student should be able to answer with 1–2 sentences or a short computation.',
    medium: 'MEDIUM difficulty — test understanding and non-trivial application. Require the student to combine two or more concepts, apply a theorem to a non-trivial instance, or verify a property formally.',
    hard:   'HARD difficulty — test deep analysis, construction, and proof. Require the student to prove a non-obvious claim, construct a counterexample, analyse the complexity of an argument, or synthesise across multiple topics. These questions should distinguish top students from the rest.',
    mixed:  'MIXED difficulty — include a spread: roughly 25% easy, 50% medium, 25% hard. Hard questions should require genuine insight.'
  }[difficulty] || 'MIXED difficulty.';

  const depthInstr = {
    surface:  'Surface depth — questions test recall and simple pattern-matching. Suitable for warm-up or comprehension checks.',
    deep:     'Deep depth — questions require genuine understanding of the underlying mathematics. Students must reason, not just recall. Expect formal justifications.',
    research: 'Research depth — questions require critical analysis, comparison of approaches, or extension of results. Students must reason beyond what was explicitly stated in the lecture.'
  }[depth] || 'Deep depth — require formal justifications and genuine understanding.';

  const formatInstr = {
    open:   'ALL questions must be open-ended written-answer questions. Multi-part structure (a)(b)(c) is strongly encouraged for complex topics.',
    mc:     'ALL questions must be multiple-choice (4 options). Distractors must reflect real misconceptions and be carefully calibrated — no obviously wrong answers.',
    proof:  'ALL questions must require a formal proof or derivation. Include: (a) state what must be proved, (b) identify the key lemma or technique, (c) carry out the proof. Partial credit structure should be visible in the sample answer.',
    mixed:  'Mix question formats: open-ended written answers (with sub-parts), multiple-choice with rigorous distractors, and proof/derivation questions. Each format should test a genuinely different skill.'
  }[format] || 'Mixed formats with formal justifications required.';

  const answerLengthInstr = {
    short:  'Expected answer length: SHORT — 1–3 sentences, a formula, or a 3–5 step derivation. Tightly scoped.',
    medium: 'Expected answer length: MEDIUM — 1 paragraph or a 5–15 step derivation. The student should be able to write it in 10–15 minutes.',
    long:   'Expected answer length: LONG — multi-paragraph essay or a complete proof with all steps. ETH written-exam style: 20–40 minutes per question.'
  }[answerLength] || 'Expected answer length: MEDIUM (10–15 minutes per question).';

  const countInstr = questionsPerBlock
    ? 'Generate 1–2 questions per block, prioritising the blocks most likely to appear on ETH exams (emphasis on theorems, algorithms, and proof techniques).'
    : `Generate exactly ${count} questions total.`;

  const langInstr = language
    ? `\n\nLANGUAGE: Write ALL natural-language content (questions, answers, explanations, options) in ${language}. Keep JSON keys, LaTeX, and technical notation unchanged.`
    : `\n\nLANGUAGE: Match the language of the guide content. Do not switch to English unless the guide is in English.`;

  return `You are an ETH Zürich full professor writing exam questions for a graduate-level course.${langInstr}

${countInstr}
${scopeStr}

${difficultyInstr}
${depthInstr}
${formatInstr}
${answerLengthInstr}

TARGET STANDARD: These questions must meet the rigour of an ETH written closed-book examination. Questions should:
- Require formal mathematical reasoning, not vague descriptions
- Test whether the student understands WHY a result holds, not just WHAT it is
- Include multi-part questions (a)(b)(c) that build on each other where appropriate
- For proof questions: the sample_answer must be a complete, exam-grade proof with all steps
- For open questions: the sample_answer must be a model answer a top student would write
- For MC: include a brief explanation of why each distractor is wrong

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "questions": [
    {
      "question": "string — the full question text, including all sub-parts (a)(b)(c) if applicable",
      "type": "open" | "mc" | "proof",
      "difficulty": "easy" | "medium" | "hard",
      "relevant_block": "string — title of the most relevant guide block",
      "sample_answer": "string — complete model answer; for proofs: every step; for open: what a top student writes",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0
    }
  ]
}

RULES:
- For "mc" type: include "options" (4 choices) and "correct" (0-based index). Omit these fields for other types.
- "sample_answer" must be a complete, exam-grade answer — not a hint, bullet list, or summary.
- Multi-part questions: use the "question" field to write all sub-parts. The "sample_answer" must address each sub-part separately.
- Do NOT ask trivial definitional questions — require synthesis, application, or proof.
- ETH exam question archetypes to include where content permits:
  * "State and prove [theorem]. Where does each hypothesis play a role?"
  * "Give an algorithm for [problem]. Prove its correctness and analyse its complexity."
  * "Is the following statement true or false? Prove or give a counterexample."
  * "Compare [approach A] and [approach B]. Under what conditions does [A] outperform [B]?"
  * "Suppose [hypothesis is weakened]. What breaks? Provide a counterexample."
- LaTeX ($...$) for all math in questions and answers.
- Do NOT hallucinate. Only test content present in the guide.

The guide JSON follows:`;
}

/**
 * Build the cross-lecture exam prediction system prompt.
 * Focuses on recurring themes, cross-lecture synthesis, and ETH exam patterns.
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
  count = 5,
  language = ''
} = {}) {
  const lectureList = lectures.map((l, i) => `Lecture ${i + 1}: "${l.lectureTitle}"`).join('\n');

  const difficultyInstr = {
    easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', mixed: 'MIXED (25% easy / 50% medium / 25% hard)'
  }[difficulty] || 'MIXED';

  const formatInstr = {
    open:  'open-ended written answer (with sub-parts where appropriate)',
    mc:    'multiple-choice (4 options, plausible distractors reflecting real misconceptions)',
    proof: 'formal proof or derivation (complete proof in sample_answer)',
    mixed: 'mixed: open-ended, multiple-choice, and proof questions'
  }[format] || 'mixed formats';

  const answerLengthInstr = {
    short:  'SHORT (1–3 sentences or brief derivation)',
    medium: 'MEDIUM (1 paragraph or a 5–15 step derivation, ~10–15 min)',
    long:   'LONG (multi-paragraph or complete proof, ~20–40 min)'
  }[answerLength] || 'MEDIUM';

  const langInstr = language
    ? `\n\nLANGUAGE: Write ALL natural-language content (topics, questions, answers, rationale) in ${language}. Keep JSON keys, LaTeX, and technical notation unchanged.`
    : `\n\nLANGUAGE: Match the dominant language of the provided guide content. Do not switch to English unless the guides are in English.`;

  return `You are an ETH Zürich professor who has taught the full course and is designing the final exam.${langInstr}

You are given structured guides for the following lectures:
${lectureList}

Your task: identify the cross-lecture themes and connections that are most likely to be examined, then generate high-probability exam questions that require synthesis across multiple lectures.

Generate exactly ${count} exam questions.
Difficulty: ${difficultyInstr}
Depth: ${depth} — ${depth === 'deep' ? 'questions require genuine understanding and formal justifications' : depth === 'research' ? 'questions require critical analysis and extension beyond the lecture' : 'questions test recall and direct application'}
Format: ${formatInstr}
Expected answer length: ${answerLengthInstr}

TARGET STANDARD: ETH written closed-book exam. Questions should reward students who understand the course as a unified whole, not as isolated lectures. Prioritise:
- Theorems that were built up over multiple lectures
- Algorithms or techniques that recur with variations
- Concepts where the same idea appears in different guises
- Topics where the professor's emphasis across multiple lectures signals exam importance

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation:

{
  "exam_topics": [
    {
      "topic": "string — recurring theme or cross-lecture concept",
      "confidence": "high" | "medium" | "low",
      "rationale": "string — specific evidence: which lectures, how often, professor signals",
      "source_lectures": ["string", ...]
    }
  ],
  "questions": [
    {
      "question": "string — full question with all sub-parts (a)(b)(c) if applicable",
      "type": "open" | "mc" | "proof",
      "difficulty": "easy" | "medium" | "hard",
      "source_lectures": ["string", ...],
      "sample_answer": "string — complete exam-grade model answer",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct": 0
    }
  ]
}

RULES:
- "exam_topics": list the 3–6 highest-priority cross-lecture themes. Each topic must have specific, evidence-based rationale.
- "confidence" HIGH = appears in ≥3 lectures or professor explicitly flagged; MEDIUM = appears in 2 lectures or is clearly foundational; LOW = appears in 1 lecture but connects to core themes.
- Questions should span MULTIPLE lectures where possible — pure single-lecture questions have lower prediction value.
- For "mc" type: include "options" and "correct" (0-based index). Omit for other types.
- "sample_answer" must be complete and exam-grade — not a hint.
- Multi-part questions strongly preferred for "open" and "proof" types.
- Use LaTeX ($...$) for all math.
- Do NOT hallucinate. Only reference content present in the provided guides.

The lecture guides (as JSON array) follow:`;
}

/**
 * System prompt for ephemeral "Ask about this item" chats (flashcard, quiz, exam, etc.).
 * @param {object} opts
 * @param {'flashcard'|'quiz'|'exam'|'cross_exam'|'cross_exam_topic'} opts.sourceType
 * @param {object} opts.itemPayload — serialized item the student is asking about
 * @param {string} opts.lectureTitle
 * @param {object} [opts.guide] — current lecture guide (for structural context)
 */
function buildToolAskPrompt({ sourceType, itemPayload, lectureTitle, guide } = {}) {
  const typeLabels = {
    flashcard: 'flashcard (front/back)',
    quiz: 'practice quiz question',
    exam: 'exam-style question',
    cross_exam: 'cross-lecture predicted exam question',
    cross_exam_topic: 'predicted exam topic cluster'
  };
  const label = typeLabels[sourceType] || 'study item';
  let guideOverview = '';
  if (guide?.guide?.length) {
    guideOverview = '\n--- LECTURE STRUCTURE (for orientation) ---\n' +
      guide.guide.map((b, i) => `${i + 1}. [${Math.floor(b.start_time / 60)}m] ${b.title}`).join('\n') + '\n';
  }
  const itemJson = JSON.stringify(itemPayload || {}, null, 2);

  return `You are a focused ETH Zürich study tutor. The student opened a temporary chat about ONE specific ${label} from the lecture "${lectureTitle || 'Lecture'}".

Your job: help them understand THIS item — clarify wording, explain concepts, walk through reasoning, connect to lecture material, or suggest how to study it. Stay anchored to the item below and the lecture; do not invent content not supported by the item or guide structure.

RULES:
- Answer the student's follow-up questions about this item only unless they explicitly ask to relate it to broader lecture themes.
- Use LaTeX ($...$ inline, $$...$$ display) for math. Markdown is allowed when it aids clarity.
- Be precise and exam-oriented when the item is exam/quiz content; be concise for flashcards unless the student asks for depth.
- If the student asks something unrelated to this item, briefly redirect them to what you can help with here.

--- ITEM TO DISCUSS (${sourceType}) ---
${itemJson}
${guideOverview}
--- END ITEM ---`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    GUIDE_SYSTEM_PROMPT,
    buildQASystemPrompt,
    buildFlashcardsPrompt,
    normalizeFlashcardTypeSelection,
    buildQuizPrompt,
    buildExamQuestionsPrompt,
    buildCrossLecturePredictionPrompt,
    buildToolAskPrompt
  };
}
