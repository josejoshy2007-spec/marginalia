/**
 * IB Diploma conventions added to every generator and the chat when a subject has an IB course
 * (port of backend ib.py). Secondary sources; the subject guide on the IB Programme Resource
 * Centre is the authority.
 */
import type { SubjectRow } from "./db";

/** term -> [objective level 1-3, definition] */
export const COMMAND_TERMS: Record<string, [number, string]> = {
  Classify: [1, "Arrange or order by class or category."],
  Define: [1, "Give the precise meaning of a word, phrase, concept or physical quantity."],
  Draw: [1, "Represent by means of a labelled, accurate diagram or graph."],
  Identify: [1, "Provide an answer from a number of possibilities."],
  Label: [1, "Add labels to a diagram."],
  List: [1, "Give a sequence of brief answers with no explanation."],
  State: [1, "Give a specific name, value or other brief answer without explanation or calculation."],
  Annotate: [2, "Add brief notes to a diagram or graph."],
  Apply: [2, "Use an idea, equation, principle, theory or law in relation to a given problem or issue."],
  Calculate: [2, "Obtain a numerical answer showing the relevant stages in the working."],
  Describe: [2, "Give a detailed account."],
  Distinguish: [2, "Make clear the differences between two or more concepts or items."],
  Estimate: [2, "Obtain an approximate value."],
  Outline: [2, "Give a brief account or summary."],
  Trace: [2, "Follow and record the action of an algorithm."],
  Construct: [2, "Display information in a diagrammatic or logical form."],
  Analyse: [3, "Break down in order to bring out the essential elements or structure."],
  Compare: [3, "Give an account of the similarities between two (or more) items, referring to both (all) of them throughout."],
  "Compare and contrast": [3, "Give an account of similarities and differences between two (or more) items, referring to both (all) of them throughout."],
  Contrast: [3, "Give an account of the differences between two (or more) items, referring to both (all) of them throughout."],
  Deduce: [3, "Reach a conclusion from the information given."],
  Design: [3, "Produce a plan, simulation or model."],
  Determine: [3, "Obtain the only possible answer."],
  Discuss: [3, "Offer a considered and balanced review that includes a range of arguments, factors or hypotheses; opinions or conclusions should be presented clearly and supported by appropriate evidence."],
  Evaluate: [3, "Make an appraisal by weighing up the strengths and limitations."],
  Examine: [3, "Consider an argument or concept in a way that uncovers the assumptions and interrelationships of the issue."],
  Explain: [3, "Give a detailed account including reasons or causes."],
  Justify: [3, "Give valid reasons or evidence to support an answer or conclusion."],
  Predict: [3, "Give an expected result."],
  Suggest: [3, "Propose a solution, hypothesis or other possible answer."],
  "To what extent": [3, "Consider the merits or otherwise of an argument or concept; opinions and conclusions should be presented clearly and supported with appropriate evidence and sound argument."],
};

const LEVEL_NAMES: Record<number, string> = {
  1: "knowledge and understanding",
  2: "application and analysis",
  3: "synthesis and evaluation",
};

export const COURSES = [
  "Biology", "Business Management", "Chemistry", "Computer Science", "Design Technology", "Economics",
  "English A: Language and Literature", "English A: Literature",
  "Environmental Systems and Societies", "Geography", "Global Politics", "History",
  "Mathematics: Analysis and Approaches", "Mathematics: Applications and Interpretation", "Physics",
  "Psychology", "Spanish ab initio", "Spanish B", "Sports, Exercise and Health Science", "Theory of Knowledge",
];

export function courseLabel(subject: SubjectRow | undefined | null): string {
  const course = (subject?.ib_course ?? "").trim();
  if (!course) return "";
  const level = (subject?.ib_level ?? "").trim();
  return `IB ${course}${level ? " " + level : ""}`;
}

export function commandTermsBlock(): string {
  return [1, 2, 3]
    .map((lvl) => {
      const terms = Object.entries(COMMAND_TERMS)
        .filter(([, [lv]]) => lv === lvl)
        .map(([t, [, d]]) => `- ${t}: ${d}`);
      return `Objective ${lvl} (${LEVEL_NAMES[lvl]}):\n${terms.join("\n")}`;
    })
    .join("\n\n");
}

/** System-prompt addendum for a subject with an IB course; "" otherwise. */
export function context(subject: SubjectRow | undefined | null): string {
  const label = courseLabel(subject);
  if (!label) return "";
  return `

The student is studying ${label} in the IB Diploma Programme. Align everything with how the IB teaches and assesses this course:
- Use the course's own terminology and the IB command terms with their official meanings (below). A command term sets the depth: State/Define/List need brief precise answers; Describe/Outline/Distinguish need an account; Explain needs reasons or causes; Discuss/Evaluate/To what extent need a balanced appraisal with a supported conclusion.
- Mark values in square brackets after a question, e.g. [4], indicate how many creditworthy points are expected.
- Prefer precise definitions and key terms exactly as an IB markscheme would credit them, and point out common ways students lose marks.
- Where the sources include exam-style or syllabus content, mirror its structure.

IB command terms:
${commandTermsBlock()}${topicsSection(subject)}`;
}

// ---------------------------------------------------------------- syllabus topics

export type Topic = {
  code: string;
  name: string;
  /** "HL" = higher level only (AHL for the Mathematics courses). Omitted when taught at both levels. */
  level?: "HL" | "AHL";
  terms: string[];
};

/**
 * Best-effort summary of each course's topics, written from general knowledge of the guides (Physics 2023
 * guide, first exams 2025; Computer Science 2027 syllabus; Economics 2020 guide; Mathematics: AA). It is
 * here so "A4" means something to the generators. The IB subject guide is the authority, and sub-topic
 * numbering is deliberately left out where it isn't certain.
 */
export const SYLLABUS: Record<string, Topic[]> = {
  Physics: [
    { code: "A.1", name: "Kinematics", terms: ["displacement, velocity, acceleration", "equations of uniformly accelerated motion", "projectile motion", "motion graphs", "fluid resistance and terminal speed"] },
    { code: "A.2", name: "Forces and momentum", terms: ["Newton's three laws", "free-body diagrams", "friction and drag", "linear momentum and impulse", "conservation of momentum", "elastic and inelastic collisions", "circular motion and centripetal force"] },
    { code: "A.3", name: "Work, energy and power", terms: ["work done by a force", "kinetic, gravitational potential and elastic energy", "conservation of energy", "power and efficiency", "Sankey diagrams"] },
    { code: "A.4", name: "Rigid body mechanics", level: "HL", terms: ["torque", "moment of inertia", "rotational equilibrium", "angular acceleration", "angular momentum and its conservation", "rotational kinetic energy", "rolling without slipping", "angular impulse"] },
    { code: "A.5", name: "Galilean and special relativity", level: "HL", terms: ["inertial frames and Galilean transformations", "postulates of special relativity", "Lorentz transformations", "time dilation and length contraction", "spacetime diagrams", "relativistic momentum and energy", "velocity addition", "invariant quantities"] },
    { code: "B.1", name: "Thermal energy transfers", terms: ["temperature and internal energy", "specific heat capacity", "specific latent heat", "conduction, convection, radiation", "black-body radiation and Stefan-Boltzmann law", "Wien's law", "emissivity and albedo"] },
    { code: "B.2", name: "Greenhouse effect", terms: ["solar radiation and the solar constant", "albedo", "greenhouse gases", "energy balance of the Earth", "enhanced greenhouse effect", "emissivity of the Earth"] },
    { code: "B.3", name: "Gas laws", terms: ["amount of substance and the mole", "ideal gas equation", "Boyle's, Charles's and pressure laws", "kinetic model of an ideal gas", "distribution of molecular speeds", "real vs ideal gases"] },
    { code: "B.4", name: "Thermodynamics", level: "HL", terms: ["first law of thermodynamics", "work done by a gas (area under p-V graph)", "isothermal, adiabatic, isobaric, isovolumetric processes", "second law and entropy", "heat engines, Carnot cycle and efficiency"] },
    { code: "B.5", name: "Current and circuits", terms: ["charge and current", "potential difference and emf", "resistance, resistivity and Ohm's law", "internal resistance", "series and parallel circuits", "potential dividers", "electrical power", "ammeters and voltmeters", "I-V characteristics"] },
    { code: "C.1", name: "Simple harmonic motion", terms: ["restoring force proportional to displacement", "period, frequency, amplitude", "a = -omega^2 x", "energy in SHM", "mass-spring and pendulum systems", "damping and resonance"] },
    { code: "C.2", name: "Wave model", terms: ["transverse and longitudinal waves", "wavelength, frequency, wave speed", "wavefronts and rays", "amplitude and intensity", "superposition", "the electromagnetic spectrum", "polarisation and Malus's law"] },
    { code: "C.3", name: "Wave phenomena", terms: ["reflection and refraction", "Snell's law and critical angle", "diffraction", "single-slit diffraction", "double-slit interference", "thin-film interference", "diffraction gratings (HL)", "Rayleigh criterion and resolution (HL)"] },
    { code: "C.4", name: "Standing waves and resonance", terms: ["nodes and antinodes", "standing waves on strings", "pipes open and closed at one end", "harmonics and fundamental frequency", "boundary conditions", "resonance"] },
    { code: "C.5", name: "Doppler effect", terms: ["moving source and observer", "observed frequency change", "wavefront compression", "Doppler shift for light", "red shift and blue shift", "applications such as speed measurement"] },
    { code: "D.1", name: "Gravitational fields", terms: ["Newton's law of gravitation", "gravitational field strength", "gravitational potential and potential energy", "equipotentials", "escape speed", "orbital motion and Kepler's laws", "orbital energy"] },
    { code: "D.2", name: "Electric and magnetic fields", terms: ["Coulomb's law", "electric field strength", "electric potential and potential energy", "equipotential surfaces", "magnetic field and magnetic force on moving charges and currents", "field lines", "capacitance (HL)"] },
    { code: "D.3", name: "Motion in electromagnetic fields", terms: ["charged particles in uniform electric fields", "charged particles in magnetic fields: circular paths", "velocity selector", "Hall effect", "force on a current-carrying conductor", "force between parallel currents"] },
    { code: "D.4", name: "Induction", level: "HL", terms: ["magnetic flux and flux linkage", "Faraday's law", "Lenz's law", "induced emf in moving conductors and rotating coils", "alternating current: rms and peak values", "transformers", "rectification", "capacitor charge and discharge, time constant"] },
    { code: "E.1", name: "Structure of the atom", terms: ["emission and absorption line spectra", "energy levels", "photon energy E = hf", "Bohr model of hydrogen", "nuclear structure, nucleons, isotopes", "Rutherford scattering", "fundamental forces and particles, quarks, leptons, Standard Model"] },
    { code: "E.2", name: "Quantum physics", level: "HL", terms: ["photoelectric effect", "work function and threshold frequency", "wave-particle duality", "de Broglie wavelength", "matter waves", "Heisenberg uncertainty principle", "Schrodinger model and probability density", "quantum tunnelling"] },
    { code: "E.3", name: "Radioactive decay", terms: ["alpha, beta and gamma decay", "decay equations", "half-life and decay constant", "activity and exponential decay", "background radiation", "nuclear stability and binding energy per nucleon", "mass defect"] },
    { code: "E.4", name: "Fission", terms: ["nuclear fission and chain reactions", "binding energy curve", "moderators, control rods, coolant", "critical mass", "energy released in fission", "nuclear waste and safety", "nuclear power plant energy transformations"] },
    { code: "E.5", name: "Fusion and stars", terms: ["nuclear fusion and temperature requirement", "stellar equilibrium", "Hertzsprung-Russell diagram", "luminosity and apparent brightness", "stellar parallax", "star life cycle", "Hubble's law and the expanding universe", "cosmic microwave background"] },
  ],

  "Mathematics: Analysis and Approaches": [
    { code: "1", name: "Number and algebra", terms: ["sequences and series (arithmetic, geometric)", "sigma notation", "exponents and logarithms", "binomial theorem", "proof", "AHL: complex numbers, polar and Euler form, de Moivre's theorem, systems of linear equations, proof by induction and contradiction, partial fractions"] },
    { code: "2", name: "Functions", terms: ["function notation, domain and range", "inverse and composite functions", "graphs and transformations", "linear, quadratic, exponential, logarithmic and rational functions", "solving equations graphically and analytically", "AHL: factor and remainder theorems, sum and product of roots, modulus and reciprocal functions, odd and even functions"] },
    { code: "3", name: "Geometry and trigonometry", terms: ["volume and surface area of 3D solids", "right-angled and non-right-angled trigonometry, sine and cosine rules", "radian measure, arc length, sector area", "unit circle, trigonometric identities, graphs and equations", "AHL: reciprocal and inverse trig functions, compound angle identities, vectors (scalar and vector products, lines and planes in 3D)"] },
    { code: "4", name: "Statistics and probability", terms: ["descriptive statistics, quartiles, box plots", "correlation and regression", "probability, conditional probability, independent events", "discrete random variables and expected value", "binomial and normal distributions", "AHL: Bayes' theorem, continuous random variables, transformations of random variables"] },
    { code: "5", name: "Calculus", terms: ["limits and derivatives", "differentiation rules: power, chain, product, quotient", "tangents and normals", "stationary points and optimisation, concavity", "integration, definite integrals and area", "kinematics with calculus", "AHL: L'Hopital's rule, implicit differentiation, related rates, integration by substitution and parts, differential equations, Maclaurin series, volumes of revolution"] },
  ],

  "Computer Science": [
    { code: "A1", name: "Computer fundamentals", terms: ["hardware: CPU, memory, storage, input and output", "fetch-decode-execute cycle", "operating systems", "data representation: binary, hexadecimal, text, images", "compilation vs interpretation", "translation and error types"] },
    { code: "A2", name: "Networks", terms: ["network types and topologies", "protocols and layered models", "IP addressing, DNS, routing", "packet switching and transmission", "network security and encryption", "client-server and cloud models", "the web and its technologies"] },
    { code: "A3", name: "Databases", terms: ["relational model, tables, keys", "entity-relationship diagrams", "SQL queries", "normalisation", "transactions and integrity", "database security", "non-relational databases"] },
    { code: "A4", name: "Machine learning", terms: ["supervised and unsupervised learning", "training and test data", "classification and regression", "neural networks", "evaluating models: accuracy, overfitting", "bias and ethics of AI systems"] },
    { code: "B1", name: "Computational thinking", terms: ["decomposition", "pattern recognition", "abstraction", "algorithm design", "flowcharts and pseudocode", "tracing algorithms", "searching and sorting algorithms", "efficiency and Big O notation"] },
    { code: "B2", name: "Programming", terms: ["variables, data types, operators", "selection and iteration", "functions and parameters", "arrays and lists", "recursion", "file handling", "testing and debugging", "error handling"] },
    { code: "B3", name: "Object-oriented programming", terms: ["classes and objects", "encapsulation", "inheritance", "polymorphism", "attributes and methods", "UML class diagrams", "design principles"] },
    { code: "B4", name: "Abstract data types", level: "HL", terms: ["stacks and queues", "linked lists", "trees and binary search trees", "graphs", "hash tables", "operations and their complexity", "traversal algorithms"] },
  ],

  Economics: [
    { code: "1", name: "Introduction to economics", terms: ["scarcity, choice and opportunity cost", "the economic problem", "factors of production", "economic systems", "positive and normative statements", "production possibilities curve", "economic models and ceteris paribus"] },
    { code: "2", name: "Microeconomics", terms: ["demand, supply and market equilibrium", "elasticities (price, income, cross, supply)", "consumer and producer surplus", "government intervention: taxes, subsidies, price controls", "externalities and market failure", "public goods and common pool resources", "market power and monopoly", "HL: production and costs, perfect competition, monopolistic competition, oligopoly, game theory"] },
    { code: "3", name: "Macroeconomics", terms: ["aggregate demand and aggregate supply", "GDP and economic growth", "unemployment and inflation", "the circular flow of income", "fiscal, monetary and supply-side policy", "income distribution and equity", "Keynesian and monetarist views", "HL: Phillips curve, Laffer curve, multiplier"] },
    { code: "4", name: "The global economy", terms: ["benefits of international trade", "protectionism: tariffs, quotas, subsidies", "exchange rates", "balance of payments", "economic integration and trade blocs", "terms of trade", "economic development: measures, barriers and strategies", "sustainable development"] },
  ],
};

export function topicsFor(course: string | undefined | null): Topic[] {
  return SYLLABUS[(course ?? "").trim()] ?? [];
}

/** Compact one-line-per-topic list for the system prompt. */
export function topicListBlock(course: string | undefined | null): string {
  return topicsFor(course)
    .map((t) => `- ${t.code} ${t.name}${t.level ? ` (${t.level} only)` : ""}`)
    .join("\n");
}

function topicsSection(subject: SubjectRow | undefined | null): string {
  const list = topicListBlock(subject?.ib_course);
  return list
    ? `\n\nSyllabus topics for this course (so a code such as "${topicsFor(subject?.ib_course)[0].code}" means the matching topic; a summary only, the IB subject guide is the authority):\n${list}`
    : "";
}

export type ResolvedFocus = {
  /** Text to retrieve passages with: the topic name plus its key terms (or the focus unchanged). */
  query: string;
  /** What goes into the generator prompt in place of the plain focus. */
  prompt: string;
  topic?: Topic;
  /** Set when an HL-only topic was asked for in an SL subject. */
  note?: string;
};

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const ON_TOPIC =
  "Write only on this topic. Use only the passages that are relevant to it, and write fewer items rather " +
  "than add anything off-topic; do not invent content beyond the passages.";

function findTopic(focus: string, topics: Topic[], codesOnly: boolean): Topic | undefined {
  const lettered = /^[A-Z]/.test(topics[0].code);
  if (lettered) {
    // "A4", "A.4", "a4", "topic A.4", "physics A4", "B.5 circuits"; also "topic A 4"
    const re = /(?:^|[^\p{L}\p{N}])(?:topic\s+|section\s+)?([A-Ea-e])\s?\.?\s?(\d{1,2})(?![\p{N}])/giu;
    for (const m of focus.matchAll(re)) {
      const spaced = /[A-Ea-e]\s\d/.test(m[0]);
      if (spaced && !/(topic|section)\s/i.test(m[0])) continue; // "a 4 mark question" is not a code
      const t = topics.find((x) => x.code.replace(".", "").toLowerCase() === `${m[1]}${m[2]}`.toLowerCase());
      if (t) return t;
    }
  } else {
    // numeric units: "topic 3", "unit 2", or a bare "3"
    const m = focus.match(/^\s*(?:(?:topic|unit|section)\s*)?(\d)\s*$/i) ?? focus.match(/\b(?:topic|unit|section)\s*(\d)\b/i);
    if (m) {
      const t = topics.find((x) => x.code === m[1]);
      if (t) return t;
    }
  }
  if (codesOnly) return undefined;
  const f = norm(focus);
  if (f.length < 4) return undefined;
  return topics
    .map((t) => ({ t, n: norm(t.name) }))
    .filter(({ n }) => f.includes(n) || (f.length >= 5 && n.includes(f)))
    .sort((a, b) => b.n.length - a.n.length)[0]?.t;
}

/**
 * Turn a focus such as "A4", "a.4", "topic A.4", "physics A4", "B.5 circuits" or "rigid body mechanics" into
 * an expanded retrieval query and a prompt line, using the course's SYLLABUS. Anything not recognised comes
 * back unchanged (query = prompt = the focus).
 */
export function resolveFocus(
  focus: string | null | undefined,
  course: string | null | undefined,
  level?: string | null,
  opts: { codesOnly?: boolean } = {},
): ResolvedFocus {
  const raw = (focus ?? "").trim();
  const same: ResolvedFocus = { query: raw, prompt: raw };
  if (!raw) return same;
  const topics = topicsFor(course);
  const topic = topics.length ? findTopic(raw, topics, !!opts.codesOnly) : undefined;
  if (!topic) return same;
  const hlOnly = !!topic.level;
  const note =
    hlOnly && (level ?? "").trim().toUpperCase() === "SL"
      ? `${topic.code} ${topic.name} is ${topic.level}-only content, but the student asked for it, so pitch it accessibly.`
      : undefined;
  // Code-only ("A4", "topic A.4", "unit 3") or just the topic's name: the expanded query is enough.
  const bare =
    norm(raw) === norm(topic.name) ||
    /^(?:(?:topic|section|unit)\s*)?[A-Ea-e]?\s?\.?\s?\d{1,2}$/i.test(raw);
  const extra = norm(raw) !== norm(topic.name) && raw.length > 5 ? ` The student's own words: "${raw}".` : "";
  const tag = `IB ${(course ?? "").trim()} topic ${topic.code} ${topic.name}${hlOnly ? ` (${topic.level} only)` : ""}`;
  return {
    query: bare ? `${topic.name}. ${topic.terms.join(", ")}` : `${raw}. ${topic.name}. ${topic.terms.join(", ")}`,
    prompt: `${tag}: covers ${topic.terms.join("; ")}.${extra} ${note ? note + " " : ""}${ON_TOPIC}`,
    topic,
    note,
  };
}

export const MARKING_RULES = `You are an experienced IB examiner. Mark exactly as IB examiners do:
- Mark positively: award credit for what is correct; never deduct for errors or omissions. Whole marks only.
- Analytic markschemes: award each listed point (its [n] marks) when the answer conveys it, accepting equivalent wording (OWTTE: "or words to that effect") and valid alternatives not listed if clearly correct. Do not award a point twice. Do not award repetition of the question, or vague answers that don't meet the command term (e.g. a description when "explain" needs reasons).
- Respect the command term: an "explain" point needs the reason/link; a "compare" needs both items referenced; "evaluate/discuss/to what extent" needs weighing and a supported conclusion for the top band.
- Error carried forward (ECF): if a later part correctly uses an earlier wrong value, credit the later method.
- Markbands (extended response): read the whole answer, find the best-fit level descriptor (start low, move up), then place it within the band's range by how securely it meets that level.
- Never award more than the question's total marks.`;

/**
 * Best-effort description of how IB papers for each course are usually phrased and structured, written from
 * general knowledge (patterns only; no past-paper text). Used by exam practice's "Like IB papers" style so
 * generated questions look like the real thing. Paper layouts change between syllabus versions, so the
 * IB subject guide and specimen papers are the authority.
 */
export const PAPER_STYLE: Record<string, string> = {
  Physics:
    "Paper 1 is multiple choice (1 mark each, a short stem and four options, often a calculation or a graph reading). " +
    "Paper 2 is structured: a data or experiment stem (\"A student investigates...\"), then parts (a), (b), (c) of rising demand. " +
    "Typical marks: State/Identify/Define [1], Calculate/Determine [2-3] with substitution then answer and unit, " +
    "Outline/Describe [2-3], Explain/Suggest [2-4] with linked reasoning, Sketch/Estimate/Deduce [2-3], " +
    "Discuss/Evaluate [3-4] in the last part. Uncertainties, units, significant figures and graph interpretation " +
    "(gradient, intercept, area) come up often. Markschemes award method, substitution and answer separately, " +
    "with ECF and \"allow\" notes. There is usually no essay with markbands; the longest answers are 4-6 marks of reasoning.",
  "Mathematics: Analysis and Approaches":
    "Papers use short-response questions (about 5-7 marks) and long-response questions (about 12-20 marks) split into " +
    "parts (a), (b), (c)... that build on each other. Command terms: Find, Show that, Hence find, Determine, Solve, " +
    "Sketch, Prove, Write down, Express, Verify. Marks are method (M), accuracy (A), and reasoning (R) with follow-through (FT) " +
    "after an earlier error; \"Show that\" parts give the answer and require full working. A realistic context or a function " +
    "defined in a stem is common (\"The function f is defined by...\", a model of a population or a path). Some questions " +
    "forbid or require a calculator. Later parts often combine topics (calculus with trigonometry, sequences with logarithms).",
  "Computer Science":
    "Papers contain short-answer questions (1-4 marks, Define/State/Outline/Describe/Explain/Distinguish), structured questions " +
    "with parts (a), (b), (c), and a final extended item (about 6-8 marks, Discuss/Evaluate/To what extent) with markbands. " +
    "Many questions give a scenario about an organisation or system (\"A school is developing a system to...\") and ask the " +
    "student to apply concepts to it. Programming-style items use pseudocode or the course's stated language: trace, complete, " +
    "write or correct a short algorithm (Trace/Construct/Outline the steps) with marks for each correct structure. Also expect " +
    "Compare and Evaluate items on trade-offs (cost, security, ethics, performance). Markschemes list distinct creditable points " +
    "with \"accept\" and \"do not accept\" notes; syllabus details follow the 2027 course and the guide is the authority.",
  Economics:
    "Papers combine short-answer and extended-response questions, often built on a news-style extract with a few numbers. " +
    "Typical items: Define [2] (a term with an example or formula), Explain [4] with a labelled diagram described in words " +
    "(shifts, equilibrium, welfare area), Calculate [2-3] (elasticity, multiplier, GDP growth), Distinguish [2-4], " +
    "Evaluate/Discuss/To what extent [10-15] marked with markbands for knowledge, application to the stem, analysis, " +
    "balance (evaluation) and a conclusion. Extracts often cite a country and policy (a subsidy, an interest-rate change) " +
    "and ask the student to use it. Diagrams matter but a marker reading text cannot see them, so ask students to describe " +
    "what the diagram shows. Markschemes are indicative content with accept/reject notes.",
  "English A: Language and Literature":
    "Assessment is analysis of unseen material rather than recall. Paper 1 gives two unseen non-literary texts (an editorial, an advert, " +
    "a blog, a speech) and asks a guiding question or a comparative analysis of how meaning is made through language, structure " +
    "and audience (Analyse, Compare and contrast, To what extent, Discuss). Paper 2 is a comparative essay on studied works " +
    "answering one of several broad statements. Questions are open prompts with a single mark out of 20-30 awarded across criteria " +
    "(understanding and interpretation, analysis and evaluation, focus and organisation, language), not analytic points. " +
    "When asked for markbands, the descriptors should name those criteria; indicative content lists possible, not required, observations.",
  "Spanish ab initio":
    "Paper 1 is productive: short writing tasks in Spanish of about 70-150 words (an email, a blog entry, a message) on a familiar " +
    "theme (identities, experiences, human ingenuity, social organisation, sharing the planet) with a stated purpose and audience, " +
    "marked on message and language (vocabulary, grammar, register). Paper 2 is receptive: reading and listening comprehension " +
    "with short items (1-2 marks) such as true/false with justification, matching, short answers, and choose-the-correct-option. " +
    "Instructions and question stems are usually in Spanish with simple vocabulary. Markschemes credit meaning even with minor " +
    "errors for comprehension items and use criteria bands for writing.",
};

/** Prompt section for the "Like IB papers" exam style; empty when the course has no entry. */
export function paperStyleSection(course: string | undefined | null, level?: string | null): string {
  const guide = PAPER_STYLE[(course ?? "").trim()];
  if (!guide) return "";
  const who = `IB ${(course ?? "").trim()}${level ? " " + level : ""}`;
  return (
    `\n\nPaper style: model the questions on how ${who} papers are usually phrased and structured, using this ` +
    `best-effort description (patterns only; do not reproduce any real past-paper question):\n${guide}\n` +
    "Open each question with its command term, use typical mark splits (1-3 mark items first, then multi-part " +
    "structured questions labelled (a), (b), (c) inside one `question` where it fits, then 4-9 mark items), use a realistic " +
    "context-setting stem where the papers do (\"A student investigates...\"), and " +
    (examProfile(course).allowsExtended
      ? "use markbands for extended items where the papers do. "
      : "do not use markbands or extended essay items. ") +
    "The content must still come only from the passages, so every markscheme point is supported by them and `cite` " +
    "is filled in; change the style, not the source of the content." +
    (level === "SL" ? " Keep to standard-level depth." : level === "HL" ? " Include some higher-level demand." : "")
  );
}

// ---------------------------------------------------------------- per-course exam profile

export type MarkingStyle = "maths" | "science" | "essay" | "language";

export type ExamProfile = {
  /** Terms the course's papers actually use (preference order for normalising). */
  commandTerms: string[];
  markingStyle: MarkingStyle;
  /** Whether extended-response (markband) items exist on this course's papers. */
  allowsExtended: boolean;
  /** Typical mark values, in words, for the prompt. */
  typicalMarks: string;
  /** Show "Objective n" labels (only where they make sense for the course). */
  objectiveLabels: boolean;
  /** Paper-section labels shown instead of objectives: [short items, long items]. */
  sectionLabels?: [string, string];
  /** Whether the course has calculator / no-calculator papers. */
  calculator?: boolean;
  /** Paper styles of the course; the UI shows a paper toggle when there is more than one. */
  papers?: ExamPaper[];
};

export type Calculator = "allowed" | "none";

/** Instruction words used by maths papers that are not in the general IB command-term glossary. */
export const MATHS_TERMS: Record<string, string> = {
  "Write down": "Obtain the answer directly, with little or no working.",
  Find: "Obtain an answer, showing the relevant working.",
  Solve: "Obtain the answer(s) algebraically, numerically or graphically.",
  "Show that": "Obtain the given result with full, valid working (the answer is given: AG).",
  "Hence find": "Use the result of the previous part to find the answer.",
  "Hence show that": "Use the result of the previous part to obtain the given result.",
  Hence: "Use the result of the previous part.",
  Prove: "Give a formal, logical argument establishing a general result (for example by induction).",
  Verify: "Check that a given value or statement is correct, by substitution or calculation.",
  Sketch: "Represent by a diagram or graph with key features (shape, intercepts, asymptotes).",
  Write: "Give the answer, with little or no working.",
  Express: "Give the result in a stated form.",
  Differentiate: "Find the derivative.",
  Integrate: "Find the integral.",
  Simplify: "Write in a simpler equivalent form.",
  Expand: "Multiply out.",
  Factorise: "Write as a product of factors.",
};

const MATHS_PROFILE: ExamProfile = {
  commandTerms: [
    "Write down", "State", "Find", "Calculate", "Solve", "Show that", "Hence find", "Hence show that", "Hence",
    "Prove", "Verify", "Sketch", "Determine", "Deduce", "Estimate", "Write", "Express", "Differentiate",
    "Integrate", "Simplify", "Expand", "Factorise", "Justify", "Explain",
  ],
  markingStyle: "maths",
  allowsExtended: false,
  typicalMarks:
    "short items 1-7 marks (Section A), long multi-part items 12-20 marks (Section B), each part (a), (b), (c) worth 1-7 marks",
  objectiveLabels: false,
  sectionLabels: ["Section A (short)", "Section B (long)"],
  calculator: true,
};

const SCIENCE_TERMS = [
  "State", "Identify", "Define", "List", "Label", "Draw", "Outline", "Describe", "Explain", "Distinguish",
  "Compare", "Calculate", "Determine", "Deduce", "Estimate", "Sketch", "Suggest", "Predict", "Annotate", "Discuss", "Evaluate",
];

// ---------------------------------------------------------------- paper styles (per course)

export type CodeLanguage = "python" | "java";

/** One criterion of a criterion-marked task (a mark out of `max`, graded by band descriptors). */
export type ExamCriterion = { code: string; name: string; max: number };

/** One paper style of a course (best-effort, patterns only; the subject guide is the authority). */
export type ExamPaper = {
  id: string;
  /** Toggle label. */
  label: string;
  /** Line shown under each question of this paper. */
  tag: string;
  /** One sentence shown above the questions when answering. */
  hint: string;
  /** Prompt rules for writing this paper's questions and markschemes. */
  rules: string;
  /** Extra rules for the examiner when marking this paper. */
  marking?: string;
  /** Whether markband items are allowed on this paper. */
  allowsExtended: boolean;
  /** Criterion-marked tasks: every question is one task marked against these criteria. */
  criteria?: ExamCriterion[];
  /** A set is made of `count` units of `marks` each (instead of ~15/30/50 marks). */
  unit?: { name: string; marks: number };
  /** Questions may carry a shared text (`stem`) shown above them. */
  stem?: { label: string; shared: boolean; fictional?: boolean };
  /** Spanish: every question carries an English gloss of its instructions. */
  glossed?: boolean;
  /** Programming paper: the student picks a language; answers are code. */
  code?: boolean;
};

/** Marks of the three set sizes when a paper has no `unit`. */
export const EXAM_MARKS: Record<string, number> = { short: 15, section: 30, paper: 50 };
/** Number of units in each set size for papers built from units (tasks, data sets, texts). */
export const UNIT_COUNT: Record<string, number> = { short: 1, section: 2, paper: 3 };

export function paperTotal(size: string, paper?: ExamPaper | null): number {
  if (paper?.unit) return paper.unit.marks * (UNIT_COUNT[size] ?? 1);
  return EXAM_MARKS[size] ?? EXAM_MARKS.short;
}

/** Labels for the length toggle: "~15 marks", or "1 task (20)" for papers built from units. */
export function sizeLabel(size: string, paper?: ExamPaper | null): string {
  if (!paper?.unit) return `~${paperTotal(size)} marks`;
  const n = UNIT_COUNT[size] ?? 1;
  return `${n} ${paper.unit.name}${n > 1 ? "s" : ""} (${paperTotal(size, paper)})`;
}

const PHYSICS_COMMON =
  "- Physics conventions: a calculation expects substitution, the answer with its unit and a sensible number of significant figures " +
  "(the fewest in the data, usually 2-3). Its markscheme lines are separate method (substitution or rearrangement) and answer-with-unit " +
  "marks, one mark each, with error carried forward (ECF) noted in `notes`, e.g. \"ECF from (a)\". An Explain item awards linked physics " +
  "reasoning: one mark per linked step (a claim joined to its physical reason). Every markscheme line is `marks` 1, with accept/allow/reject " +
  "notes in `notes`. Never use markbands, `indicative` content or essays.\n" +
  "- Students cannot see figures: give graph or experiment data in words (\"the graph of v against t is a straight line through the origin, " +
  "gradient 2.0 m s⁻²\") or as a small Markdown table with units in the column headings. Never refer to a figure by number.\n";

const PHYSICS_PAPERS: ExamPaper[] = [
  {
    id: "p1",
    label: "Paper 1 style",
    tag: "Paper 1 · multiple choice & data",
    hint: "Multiple choice: answer with a letter. Short items: show substitution and give the unit.",
    allowsExtended: false,
    rules:
      "Paper 1 style: mostly multiple-choice items (about two thirds of the marks) plus short data-based items.\n" +
      "- Multiple choice: `marks` 1, command_term \"Identify\". `question` is a short stem (often a calculation or a reading of data given in " +
      "words) followed by the four options on separate lines \"A. ...\" to \"D. ...\", exactly one correct, the others typical slips. The student " +
      "answers with a letter. Markscheme: one point worth 1 that starts with the letter and gives the reasoning, e.g. \"B: ...\"; `notes` say why " +
      "each distractor is wrong.\n" +
      "- Short data-based items: 1-3 marks (State, Calculate, Determine, Estimate, Deduce, Outline), the data given in words or a small table.\n" +
      PHYSICS_COMMON,
  },
  {
    id: "p2",
    label: "Paper 2 style",
    tag: "Paper 2 · structured",
    hint: "Structured questions: answer each part, show substitution, and link your reasoning.",
    allowsExtended: false,
    rules:
      "Paper 2 style: structured items. Each item opens with a short context stem inside `question` (\"A student investigates ...\", a " +
      "device, a data table), then parts (a), (b), (c) of rising demand, each ending with its marks in brackets, e.g. \"(b) Calculate ... [2]\". " +
      "Parts: State/Identify/Define [1], Calculate/Determine [2-3], Outline/Describe [2-3], Explain/Suggest [2-4], and a last Discuss/Evaluate/" +
      "Deduce [3-4]. An item is worth 6-12 marks in total (`marks`), and its markscheme lists the lines of all parts in order, naming the part " +
      "in each line (\"(b) substitution ...\"). Uncertainties, graph gradients/intercepts/areas and units come up often.\n" +
      PHYSICS_COMMON,
  },
];

const CS_PAPERS: ExamPaper[] = [
  {
    id: "theory",
    label: "Theory",
    tag: "Paper 1 · theory",
    hint: "Answer using the command term. Marks tell you how many distinct points to make.",
    allowsExtended: true,
    rules:
      "Paper 1 style (theory): short answer and structured items, with command terms and mark splits such as Identify/State [1-2], " +
      "Outline [2-3], Describe [3-4], Explain [3-6], Compare/Distinguish [2-4]. Many items start with a one-sentence scenario (\"A school is " +
      "developing a system to ...\") that the student applies concepts to. Markscheme `points`: one creditworthy idea per line, more lines than " +
      "marks where the IB says \"award [1] per ... up to [4]\", with accept / do not accept notes in `notes`. The LAST item is an extended " +
      "Discuss / Evaluate / To what extent item of 8 marks with markbands (`type` \"markbands\", 3-4 bands, descriptors on knowledge, " +
      "application to the scenario, balance and a supported conclusion) plus `indicative` content. Avoid code except a tiny pseudocode snippet in a fenced block.",
  },
  {
    id: "programming",
    label: "Programming",
    tag: "Paper 2 · algorithms & programming",
    hint: "Write code in the chosen language. Marks are per correct construct; small syntax slips do not lose marks.",
    allowsExtended: false,
    code: true,
    rules:
      "Paper 2 style (algorithms and programming): no essays and no markbands. Item types:\n" +
      "- Trace: give a short algorithm in a fenced code block and ask the student to complete a trace table (they write it as a Markdown table, " +
      "or list the values line by line). Markscheme: one mark per correct column or row group.\n" +
      "- Identify the output / State the value of a variable after a short code fragment [1-3].\n" +
      "- Construct an algorithm / Write code (a method, a loop, a search, a sort step, a class) [4-6], with the specification stated fully in " +
      "the question (inputs, outputs, edge cases). Markscheme: one mark per correct construct (loop bounds, condition, assignment, return or " +
      "output), with `notes` saying that any working equivalent is accepted.\n" +
      "- Complete or correct a given fragment [2-4]. All code goes in fenced code blocks (```), never inline for more than one line. The code and " +
      "its expected output must be exactly right: trace every example by hand before writing the markscheme. The scenario and the concepts come from the passages.",
    marking:
      "Programming marking: award one mark per correct construct named in the markscheme (loop bounds, condition, assignment, return or output). " +
      "Accept any working equivalent (a for loop for a while loop, different variable names, a different but correct approach). Ignore small " +
      "syntax slips (a missing colon, bracket or semicolon, capitalisation of a keyword) unless the question is about syntax. Do not award a " +
      "construct that would not work or that does the wrong thing. For trace tables, mark each value; for \"identify the output\", the output " +
      "must match exactly, ignoring surrounding whitespace.",
  },
];

const ECON_PAPERS: ExamPaper[] = [
  {
    id: "p1",
    label: "Paper 1",
    tag: "Paper 1 · extended response",
    hint: "Describe your diagram in words: name the axes and curves, say what shifts, and give the new equilibrium.",
    allowsExtended: true,
    unit: { name: "question", marks: 25 },
    rules:
      "Paper 1 style (extended response): each unit is ONE theme from the passages written as TWO items on the same theme.\n" +
      "- Item (a), 10 marks: begins \"(a) Explain ...\" or \"(a) Analyse ...\" and asks for a diagram. Item (b), 15 marks: begins \"(b) Evaluate ...\", " +
      "\"(b) Discuss ...\" or \"(b) To what extent ...\" and asks the student to use real-world examples.\n" +
      "- Both are marked with markbands (`type` \"markbands\", 4 bands from low to high with mark ranges such as \"1-3\", \"4-6\", \"7-8\", \"9-10\" for " +
      "(a) and \"1-4\", \"5-8\", \"9-12\", \"13-15\" for (b)). The descriptors name the criteria: correct definitions of key terms, an accurate " +
      "diagram (described in words: axes, curves, the shift, the new equilibrium), real-world examples that are used, analysis that links the " +
      "chain of cause and effect, and for (b) evaluation (short/long run, stakeholders, assumptions, magnitudes) with synthesis and a supported conclusion.\n" +
      "- Students describe diagrams in words, so ask them to \"draw and describe\". The `notes` say exactly what a correct diagram shows (axes, curves, " +
      "labels, shift, equilibrium). `indicative` lists possible, not required, content. No stem: the question text stands alone.",
    marking:
      "Economics marking: students cannot draw, so accept a clear diagram described in words (axes labelled, curves named, shift and direction, new " +
      "equilibrium) as a diagram. Place the answer in a markband using all the criteria in the descriptors (definitions, diagram, examples, " +
      "analysis, and for the evaluation part balance and a justified conclusion). A diagram that is described but not used in the argument earns less. " +
      "Unsupported assertions and lists of points without development stay in the lower bands.",
  },
  {
    id: "p2",
    label: "Paper 2",
    tag: "Paper 2 · data response",
    hint: "Use the extract and the data in your answers. Show your working for calculations.",
    allowsExtended: true,
    unit: { name: "data set", marks: 23 },
    stem: { label: "Extract (fictional: written for this question)", shared: true, fictional: true },
    rules:
      "Paper 2 style (data response): each unit is one data set with four items.\n" +
      "- `stem` of the FIRST item of the unit: a short text or data extract (about 120-200 words, plus a few numbers or a small Markdown table) " +
      "that YOU INVENT for this question, in the style of a news item about an imaginary country, industry or firm. It is fictional: begin it " +
      "with \"Fictional extract, written for this practice question.\" Build it only from the economic ideas and facts in the passages (never " +
      "real company, politician or statistic claims). Leave `stem` empty on the other three items; they use the same extract.\n" +
      "- Item 1: \"Define ...\" a key term from the passages [2] (term meaning plus a feature or example). Item 2: \"Calculate ...\" [2] from the " +
      "numbers in the extract, ending \"Show your working.\" (markscheme: 1 method/substitution, 1 answer with units or % where needed). Item 3: " +
      "\"Draw and explain ...\" with a diagram described in words [4] (the `notes` say what the correct diagram shows). Item 4: \"Using " +
      "information from the text/data and your knowledge of economics, evaluate ...\" [15], with markbands (`type` \"markbands\", 4 bands with " +
      "ranges such as \"1-4\", \"5-8\", \"9-12\", \"13-15\", on knowledge and definitions, use of the data, analysis, a diagram or example, and evaluation/synthesis) plus `indicative`.\n" +
      "- Items 1-3 use `type` \"points\" with one-mark lines. Students describe diagrams in words.",
    marking:
      "Economics marking: students cannot draw, so accept a clear diagram described in words (axes, curves, shift, new equilibrium) for diagram " +
      "marks. For \"Calculate\" award the method mark and the answer mark separately (ECF allowed). For the evaluation, use the band descriptors: " +
      "reward use of the extract's information, development of analysis, and a balanced, justified conclusion.",
  },
];

const ENGLISH_P1: ExamCriterion[] = [
  { code: "A", name: "Understanding & interpretation", max: 5 },
  { code: "B", name: "Analysis & evaluation", max: 5 },
  { code: "C", name: "Focus & organisation", max: 5 },
  { code: "D", name: "Language", max: 5 },
];
const ENGLISH_P2: ExamCriterion[] = [
  { code: "A", name: "Knowledge, understanding & interpretation", max: 10 },
  { code: "B", name: "Analysis & evaluation", max: 10 },
  { code: "C", name: "Focus & organisation", max: 5 },
  { code: "D", name: "Language", max: 5 },
];
const ENGLISH_MARKING =
  "English marking: this is criterion-marked, not point-marked. Mark each criterion separately using the band descriptors: choose the best-fit " +
  "band, then a mark within it by how securely the work meets it. Give a short comment per criterion quoting the student's words where useful, " +
  "and say what would reach the next band. Reward a clear line of argument tied to the text; do not reward plot summary, feature-spotting without " +
  "effect, or length. There are no one-mark \"correct answers\".";

const ENGLISH_PAPERS: ExamPaper[] = [
  {
    id: "p1",
    label: "Paper 1",
    tag: "Paper 1 · guided textual analysis",
    hint: "Write a focused analysis of how the writer makes meaning. Marks are for criteria A-D.",
    allowsExtended: false,
    criteria: ENGLISH_P1,
    unit: { name: "task", marks: 20 },
    stem: { label: "Excerpt from your sources", shared: false },
    rules:
      "Paper 1 style (guided textual analysis, criterion-marked). Each unit is ONE task, never recall items. `stem` is a short excerpt (about " +
      "100-250 words) quoted word for word from one passage, with its source title on a first line in brackets like \"[Source: title]\"; never invent " +
      "or alter the text. `question` is a single guiding question such as \"How does the writer ...?\" or \"In what ways does the text use language " +
      "and structure to ...?\" (command term Analyse, or Discuss). `marks` is 20. `cite` lists the passage.\n" +
      "- Markscheme: `type` \"criteria\", with `criteria` holding A (Understanding & interpretation, 5), B (Analysis & evaluation, 5), C (Focus & " +
      "organisation, 5) and D (Language, 5). Each has `code` and `descriptors`: 4-5 band descriptors (e.g. \"0\", \"1-2\", \"3\", \"4\", \"5\") describing " +
      "what the work shows at that level. `indicative` lists observations that are possible (not required), tied to the excerpt. `notes` for advice.",
    marking: ENGLISH_MARKING,
  },
  {
    id: "p2",
    label: "Paper 2",
    tag: "Paper 2 · comparative essay",
    hint: "Write a comparative essay using specific moments from the works. Marks are for criteria A-D.",
    allowsExtended: false,
    criteria: ENGLISH_P2,
    unit: { name: "task", marks: 30 },
    rules:
      "Paper 2 style (comparative essay, criterion-marked). Each unit is ONE essay prompt about literary works that appear in the passages " +
      "(never works that are not there). The prompt is a broad statement or question linking at least two works, e.g. \"In what ways and to what " +
      "effect do two of the works you have studied present ...?\" (command term Compare and contrast, Discuss or To what extent). If the passages " +
      "contain only one work, write the prompt about it and tell the student to compare it with another work they studied. No `stem`. `marks` is 30.\n" +
      "- Markscheme: `type` \"criteria\", with `criteria` holding A (Knowledge, understanding & interpretation, 10), B (Analysis & evaluation, 10), " +
      "C (Focus & organisation, 5), D (Language, 5), each with `code` and 4-5 band `descriptors` (mark ranges). `indicative` lists possible comparisons.",
    marking: ENGLISH_MARKING,
  },
];

const SPANISH_CRITERIA: ExamCriterion[] = [
  { code: "A", name: "Language", max: 12 },
  { code: "B", name: "Message", max: 12 },
  { code: "C", name: "Conceptual understanding", max: 6 },
];

const SPANISH_PAPERS: ExamPaper[] = [
  {
    id: "writing",
    label: "Writing",
    tag: "Paper 1 · writing",
    hint: "Write in Spanish within the word range and cover every bullet point. Marks are for criteria A-C.",
    allowsExtended: false,
    criteria: SPANISH_CRITERIA,
    unit: { name: "task", marks: 30 },
    glossed: true,
    rules:
      "Paper 1 style (writing, criterion-marked). Each unit is ONE writing task. Write EVERYTHING the student reads in simple Spanish (ab initio " +
      "level, A1-A2 vocabulary): the instruction, the context and the bullet points. `question` has: the text type (correo, blog, diario, artículo, " +
      "folleto, carta, mensaje ...), one or two context sentences, the word range (\"Escribe entre 70 y 150 palabras\") and two or three bullet " +
      "points of what to cover, each on its own line starting \"- \". Choose a theme from the passages (identidades, experiencias, ingenio humano, " +
      "organización social, compartir el planeta) using their vocabulary. `command_term` \"Escribe\". `marks` 30. `gloss` is an English translation " +
      "of the whole instruction.\n" +
      "- Markscheme: `type` \"criteria\", `criteria` holding A Language (12), B Message (12), C Conceptual understanding (6), each with `code` and 4-5 " +
      "band `descriptors` in English (what the vocabulary, grammar and accuracy, the relevant and developed message, and the register and text-type " +
      "conventions look like at that level). `notes` list useful vocabulary and structures for the task (in Spanish).",
    marking:
      "Spanish ab initio writing is criterion-marked: A Language (vocabulary, grammar, accuracy, range at ab initio level), B Message (all bullet " +
      "points covered, relevant, developed, clear), C Conceptual understanding (text type, register, audience and conventions). Choose the best-fit " +
      "band per criterion. Do not penalise English-style phrasing that is still correct Spanish, and do not mark an answer in English above band 1. " +
      "Write comments in English, and list the language mistakes in `mistakes`: for each, the student's words, the corrected Spanish, and a short " +
      "English note (at most 8 of the most important). Check the word range: a very short answer limits criterion B.",
  },
  {
    id: "reading",
    label: "Reading",
    tag: "Paper 2 · reading comprehension",
    hint: "Read the text, then answer in Spanish. Small spelling slips are accepted.",
    allowsExtended: false,
    unit: { name: "text", marks: 15 },
    stem: { label: "Texto (written for this task)", shared: true },
    glossed: true,
    rules:
      "Paper 2 style (reading comprehension). Each unit is one short Spanish text and 6-10 items about it, 15 marks in all.\n" +
      "- `stem` of the FIRST item of the unit: a short Spanish text of 120-200 words in simple ab initio language (an email, blog, article, " +
      "advert, notice or message) that YOU WRITE for this task on a topic from the passages, using only ideas and vocabulary found in them. Leave " +
      "`stem` empty on the other items of the unit; they use the same text.\n" +
      "- Items are in Spanish with simple vocabulary, each 1-2 marks, `command_term` a Spanish verb (Indica, Elige, Relaciona, Busca, Contesta, " +
      "Justifica): verdadero o falso with a justification from the text [2] (1 for the choice, 1 for the justification); short answers [1-2]; matching " +
      "(\"Relaciona 1-4 con A-E\") with the lists written out [1 per match]; \"¿Qué palabra del texto significa ...?\" [1]; choose the correct option [1]. " +
      "`gloss` is an English translation of the item's instruction (not of the text).\n" +
      "- Markscheme `type` \"points\": one line per mark with the expected answer in Spanish; `notes` (English) say which variants are accepted.",
    marking:
      "Reading comprehension is objectively marked on meaning: award the mark when the answer shows the idea in the markscheme. Accept minor " +
      "spelling, accent and grammar slips unless the item tests spelling or a specific word. For true/false with justification, the choice and the " +
      "justification are separate marks; a justification copied from the wrong part of the text earns nothing. Write comments in English.",
  },
];

/**
 * Best-effort description of what each course's papers use, from general knowledge of the guides (patterns
 * only; no past-paper text). The subject guide and specimen papers are the authority.
 */
export const EXAM_PROFILE: Record<string, ExamProfile> = {
  "Mathematics: Analysis and Approaches": MATHS_PROFILE,
  "Mathematics: Applications and Interpretation": {
    ...MATHS_PROFILE,
    typicalMarks: MATHS_PROFILE.typicalMarks + "; more real-world modelling, statistics and technology contexts",
  },
  Physics: {
    commandTerms: SCIENCE_TERMS.filter((t) => !["Label", "Annotate"].includes(t)),
    markingStyle: "science",
    allowsExtended: false,
    typicalMarks: "State/Identify/Define 1, Calculate/Determine 2-3, Outline/Describe 2-3, Explain/Suggest 2-4, Discuss/Evaluate 3-4",
    objectiveLabels: true,
    papers: PHYSICS_PAPERS,
  },
  Chemistry: {
    commandTerms: SCIENCE_TERMS,
    markingStyle: "science",
    allowsExtended: false,
    typicalMarks: "State/Identify/Define 1, Calculate/Determine 2-3, Outline/Describe 2-3, Explain/Suggest 2-4, Deduce/Predict 1-3",
    objectiveLabels: true,
  },
  Biology: {
    commandTerms: SCIENCE_TERMS,
    markingStyle: "science",
    allowsExtended: true,
    typicalMarks: "State/Identify 1, Outline/Describe 2-3, Explain/Suggest 2-4, Calculate 2, Discuss/Evaluate 3-6, one extended item up to 8",
    objectiveLabels: true,
  },
  "Computer Science": {
    commandTerms: [...SCIENCE_TERMS, "Trace", "Construct", "Analyse", "To what extent"],
    markingStyle: "science",
    allowsExtended: true,
    typicalMarks: "short 1-4, structured 4-6, final extended item 6-8 with markbands",
    objectiveLabels: true,
    papers: CS_PAPERS,
  },
  Economics: {
    commandTerms: [
      "Define", "Identify", "State", "Outline", "Describe", "Explain", "Distinguish", "Calculate", "Draw", "Analyse",
      "Compare", "Contrast", "Discuss", "Evaluate", "Examine", "To what extent", "Justify", "Suggest",
    ],
    markingStyle: "essay",
    allowsExtended: true,
    typicalMarks: "Define 2, Explain 4, Calculate 2-3, Distinguish 2-4, Evaluate/Discuss/To what extent 10-15 with markbands",
    objectiveLabels: true,
    papers: ECON_PAPERS,
  },
  "English A: Language and Literature": {
    commandTerms: ["Analyse", "Compare and contrast", "Discuss", "To what extent", "Evaluate", "Examine"],
    markingStyle: "language",
    allowsExtended: true,
    typicalMarks: "one open prompt marked out of 20-30 across criteria",
    objectiveLabels: false,
    papers: ENGLISH_PAPERS,
  },
  "Spanish ab initio": {
    commandTerms: ["Escribe", "Indica", "Identifica", "Elige", "Relaciona", "Completa", "Justifica", "Busca", "Explica", "Contesta"],
    markingStyle: "language",
    allowsExtended: false,
    typicalMarks: "comprehension items 1-2 marks; writing tasks 70-150 words marked on criteria",
    objectiveLabels: false,
    papers: SPANISH_PAPERS,
  },
};

/** Fallback for any other course (and for no course): the generic IB command terms, markbands allowed. */
export const GENERIC_EXAM_PROFILE: ExamProfile = {
  commandTerms: Object.keys(COMMAND_TERMS),
  markingStyle: "essay",
  allowsExtended: true,
  typicalMarks: "short 1-2, structured 2-6, extended 6-9 with markbands",
  objectiveLabels: true,
};

export function examProfile(course: string | null | undefined): ExamProfile {
  return EXAM_PROFILE[(course ?? "").trim()] ?? GENERIC_EXAM_PROFILE;
}

/** "IB Physics HL" -> { course: "Physics", level: "HL" } (the label the UI carries). */
export function parseIbLabel(label: string | null | undefined): { course: string | null; level: string | null } {
  const m = /^IB\s+(.+?)(?:\s+(SL|HL))?$/.exec((label ?? "").trim());
  return m ? { course: m[1], level: m[2] ?? null } : { course: null, level: null };
}

/** Normalise a generated command term to the course's list; "" when it names none of them. */
export function normaliseTerm(term: string, question: string, profile: ExamProfile): string {
  const find = (s: string) => profile.commandTerms.find((t) => t.toLowerCase() === s.trim().toLowerCase());
  const direct = find(term || "");
  if (direct) return direct;
  const q = (question ?? "").trim().replace(/^\(?[a-z]\)\s*/i, "").toLowerCase();
  // Longest listed term the question opens with ("Hence find ..." before "Hence").
  const lead = [...profile.commandTerms].sort((a, b) => b.length - a.length).find((t) => q.startsWith(t.toLowerCase() + " "));
  return lead ?? "";
}

/** Split a markscheme line such as "M1 (FT) set up the equation" into its mark label and text. */
export function splitMarkLabel(text: string): { label: string; rest: string } {
  const m = /^\s*(AG|[MARB]\d*(?:\s*\(?FT\)?)?)(?=[\s:.)-]|$)\s*[:.-]?\s*([\s\S]*)$/.exec(text ?? "");
  return m ? { label: m[1].replace(/\s+/g, " ").trim(), rest: m[2] } : { label: "", rest: text ?? "" };
}

/** Prompt rules for a course's exam style, used by exam writing and markscheme drafting. */
export function examProfileRules(
  profile: ExamProfile,
  opts: { calculator?: Calculator | null; paper?: string | null; language?: CodeLanguage | null } = {},
): string {
  return baseProfileRules(profile, opts) + paperRules(profile, opts.paper, opts.language);
}

/** The paper of a profile by id (undefined when the course has no papers or the id is unknown). */
export function examPaper(profile: ExamProfile, id: string | null | undefined): ExamPaper | undefined {
  return id ? profile.papers?.find((p) => p.id === id) : undefined;
}

/** Whether the UI should offer a paper toggle (more than one paper style). */
export const hasPaperChoice = (profile: ExamProfile) => (profile.papers?.length ?? 0) > 1;

/** Marks per question and what the student must produce, for the prompt of a paper-styled set. */
function paperRules(profile: ExamProfile, id: string | null | undefined, language?: CodeLanguage | null): string {
  const paper = examPaper(profile, id);
  if (!paper) return "";
  let out = `\n\nPaper: ${paper.label} (${paper.tag}). Follow this paper's structure exactly:\n${paper.rules}`;
  if (paper.code) {
    const lang = language === "java" ? "Java" : "Python 3";
    out += `\n- Programming language: ${lang}. Every code fragment, and every answer the student must write, is in ${lang} (fence it as \`\`\`${language === "java" ? "java" : "python"}).`;
  }
  if (paper.glossed)
    out += "\n- Write the questions, instructions and bullet points in SPANISH (the student answers in Spanish). Put an English translation of each instruction in `gloss`; never put English in `question`.";
  if (paper.stem?.fictional)
    out += "\n- The `stem` is invented: it must say it is fictional and must not present invented facts as real.";
  return out;
}

/** Examiner rules specific to a question's paper (code marking, criteria, diagrams); "" when none. */
export function paperMarkingRules(profile: ExamProfile, id: string | null | undefined): string {
  const paper = examPaper(profile, id);
  return paper?.marking ? "\n\n" + paper.marking : "";
}

function baseProfileRules(profile: ExamProfile, opts: { calculator?: Calculator | null }): string {
  const terms = `Command terms this course's papers use: ${profile.commandTerms.join(", ")}. Use only these.`;
  if (profile.markingStyle === "maths") {
    const calc =
      opts.calculator === "none"
        ? "Calculator: NOT allowed (Paper 1 style). Use exact values (surds, fractions, ln, pi); every answer must be reachable by hand."
        : opts.calculator === "allowed"
          ? "Calculator: allowed (Paper 2 style). Answers may be decimals to 3 significant figures; numerical, modelling or statistics contexts are fine."
          : "";
    return (
      "\n\nThis is a mathematics course. Write the questions as real IB maths papers do:\n" +
      "- Questions are direct instructions, never essays: \"Solve the equation ...\", \"Find the exact value of ...\", " +
      "\"Show that ...\", \"Hence find ...\", \"Prove by induction that ...\", \"Sketch the graph of ...\". Never ask the student to " +
      "evaluate significance, discuss, or explain a method at length. \"Explain\"/\"Justify\" only for a short 1-2 mark reason.\n" +
      "- Prefer multi-part items labelled (a), (b), (c) inside one `question`, where later parts use earlier results (\"Hence ...\"). " +
      "\"Show that\" parts state the target result.\n" +
      "- Use LaTeX for all maths, with exact values where natural. `marks` is the total of the parts.\n" +
      "- Markschemes: `type` \"points\", one line per mark in the IB style. Each line's text starts with its label: M1 (method), " +
      "A1 (accuracy, only after the related M), R1 (reasoning), B1 (independent mark) or AG (answer given in a Show that, worth 0), " +
      "then what earns it. Give each line `marks` 1 (AG: 0) so the lines sum to the total. Write (FT) after the label where an earlier " +
      "error carries forward, e.g. \"A1 (FT) ...\". Mention the part inside the sentence, e.g. \"M1 for ... in part (b)\". " +
      "Put accept and alternative-method notes in `notes`.\n" +
      "- Never use markbands, `indicative` content or an extended-response item.\n" +
      (calc ? `- ${calc}\n` : "") +
      `- Typical marks: ${profile.typicalMarks}.\n` +
      terms
    );
  }
  if (profile.markingStyle === "science") {
    return (
      "\n\nThis is a science/technical course. " + terms + ` Typical marks: ${profile.typicalMarks}. ` +
      "Calculations show substitution, the answer with its unit and a stated number of significant figures, with separate method and answer marks " +
      "(use ECF notes). " + (profile.allowsExtended ? "" : "There are no essay or markband items; the longest answers are 4-6 marks of linked reasoning.")
    );
  }
  if (profile.markingStyle === "language") {
    if (profile.papers) return `\n\nThis is a language/literature course. ${terms}`;
    return `\n\nThis is a language/literature course. ${terms} Typical marks: ${profile.typicalMarks}. Mark by criteria rather than analytic points where the item is writing or analysis.`;
  }
  return "";
}

/** Extra marking rules for a profile (M/A conventions for maths; empty otherwise). */
export function markingStyleRules(profile: ExamProfile): string {
  if (profile.markingStyle !== "maths") return "";
  return `
Mathematics marking (IB conventions):
- Each markscheme line is labelled M (method), A (accuracy), R (reasoning), B (independent mark) or AG (answer given, 0 marks). Award M1 for a correct method even if an arithmetic slip follows. Award A1 only when the related M was earned (unless the line is independent), and only for a correct result.
- Follow-through (FT): if an earlier error is carried into a later part and that part is done correctly with the wrong value, award the M marks and the A marks marked (FT), unless the later work became trivial.
- Never require prose explanations: judge the working and the equations. A correct bare answer with no working earns the A marks only where the markscheme allows it (for example "write down" lines); otherwise award only independent marks.
- "Show that": the working must reach the given result validly; a missing or unjustified step loses the final mark (AG itself earns nothing).
- A valid alternative method earns the equivalent marks. Do not award a mark twice. Refer to the labels (M1, A1, ...) in your comments.`;
}
