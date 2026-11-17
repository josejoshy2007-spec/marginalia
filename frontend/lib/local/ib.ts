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
