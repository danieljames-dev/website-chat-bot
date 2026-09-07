/* Website Chat Bot — deterministic FAQ widget. No network calls, no API key, no tracking.
 * Everything it can say comes from the config object on this page. */
(function () {
  "use strict";
  /**
   * The whole product, minus presentation.
   *
   * A deterministic question-answering engine for a small business website. It is not a language
   * model and must never be sold as one: it matches a visitor's question against a list of facts the
   * business itself supplied, and when nothing matches well enough it says so and hands the visitor a
   * way to reach a human. There is no network call, no API key, no server and no per-answer cost, so a
   * one-dollar sale cannot create an unbounded liability.
   *
   * Three rules hold everywhere in this file and are each covered by tests:
   *
   *   1. Every answer carries a `source` naming exactly where its text came from. Text that cannot
   *      name a source is never returned. That is the structural form of "never invent a business
   *      fact" -- there is no code path that composes an answer out of anything but supplied data.
   *   2. Recognising a question is not the same as being able to answer it. An intent can win the
   *      match and still produce `unknown`, because the business left that field empty.
   *   3. Language support is data, not code. Nothing here contains an English word; stopwords are
   *      discovered by rarity (idf) rather than listed, and script handling is by Unicode property.
   *      One engine serves every locale, which is what makes the wrapper system possible at all.
   */

  /* ---------------------------------------------------------------------------------------------
   * Text normalisation
   * ------------------------------------------------------------------------------------------ */

  /**
   * Fold a string to its comparison form.
   *
   * Diacritics are stripped ONLY from Latin bases. This distinction matters and is easy to get
   * wrong: in Devanagari and Arabic the combining marks are vowels, not decoration -- stripping
   * `\p{Mn}` globally turns "किराया" and "किराए" into the same token as half the dictionary. Both the
   * query and the stored question pass through the same function, so folding Latin accents costs
   * nothing (café == cafe) while leaving Indic and Arabic text intact.
   */
  function normalizeText(input) {
    if (typeof input !== "string") return "";
    return input
      .normalize("NFKC")
      .toLowerCase()
      .normalize("NFD")
      .replace(/(\p{Script=Latin})\p{Mn}+/gu, "$1")
      .normalize("NFC")
      .trim();
  }

  /* Scripts that do not put spaces between words. A "token" in Japanese is frequently a whole
   * sentence, which would make token overlap meaningless, so those runs are cut into character
   * bigrams instead -- crude, but it restores the property the scorer depends on. */
  const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

  function bigrams(run) {
    if (run.length <= 1) return [run];
    const out = [];
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
    return out;
  }

  /** Split folded text into comparable tokens. Punctuation and emoji fall away; digits are kept. */
  function tokenize(input) {
    const folded = normalizeText(input);
    const runs = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
    const out = [];
    for (const run of runs) {
      if (SPACELESS.test(run) && run.length > 1) out.push(...bigrams(run));
      else out.push(run);
    }
    return out;
  }

  /* ---------------------------------------------------------------------------------------------
   * Fuzzy token equality
   * ------------------------------------------------------------------------------------------ */

  /** Levenshtein distance, bounded: returns `max + 1` as soon as it is certain the distance exceeds
   * `max`, so a long-word comparison cannot dominate a hot loop. */
  function editDistance(a, b, max = 2) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      let best = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
        if (row[j] < best) best = row[j];
      }
      if (best > max) return max + 1;
      prev = row;
    }
    return prev[b.length];
  }

  /* A typo budget that scales with the word. Three letters get none -- at that length one edit is a
   * different word ("cat"/"car", "hoy"/"soy") and a budget there is how a fuzzy matcher starts
   * answering questions nobody asked. */
  function typoBudget(token) {
    if (token.length <= 3) return 0;
    if (token.length <= 6) return 1;
    return 2;
  }

  /** True when two tokens are the same word allowing for a typo or a short suffix (plural, gender). */
  function tokensMatch(a, b) {
    if (a === b) return true;
    const budget = typoBudget(a.length <= b.length ? a : b);
    if (budget === 0) return false;
    if (a.length >= 4 && b.length >= 4) {
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (longer.startsWith(shorter) && longer.length - shorter.length <= 2) return true;
    }
    return editDistance(a, b, budget) <= budget;
  }

  /* ---------------------------------------------------------------------------------------------
   * Candidates
   * ------------------------------------------------------------------------------------------ */

  const DEFAULTS = Object.freeze({
    minScore: 0.4,
    minMargin: 0.08,
    maxChoices: 3,
  });

  /* Fields the engine can answer from directly, and the business key each one requires. An intent
   * whose required value is missing produces `unknown`; it never produces a guess. */
  const FIELD_INTENTS = Object.freeze({
    hours: "hours",
    address: "address",
    phone: "phone",
    email: "email",
    website: "website",
    services: "services",
    pricing: "pricing",
  });

  /**
   * A candidate is matched one PHRASE at a time, and its score is the best any single phrase
   * achieves.
   *
   * The first version of this scorer pooled every phrase of a candidate into one bag of tokens and
   * scored the bag. That is the obvious design and it is wrong in a way worth recording, because the
   * fixtures caught it: an intent with seven phrasings has a token bag seven phrasings wide, so its
   * precision against any real question is terrible, while a two-word FAQ keyword list scores
   * suspiciously well on nothing. Pooling also destroys phrase structure -- "what time" and "when are
   * you open" are two ways to ask the same thing, not one seven-word question nobody would ask.
   *
   * Scoring the phrases separately and keeping the maximum fixed three misclassifications at once:
   * a Portuguese "qual o horário de vocês?" that answered with the service list, a Japanese opening-
   * hours question that fell below the threshold, and a misspelled "emergancy callout" that matched
   * nothing.
   */
  function phrasesOf(text) {
    return typeof text === "string" && text.trim() !== "" ? [text] : [];
  }

  /** Written scripts with no word spacing, where token overlap is not a meaningful measure. */
  const SPACELESS_PHRASE = (text) => !/\s/.test(text) && SPACELESS.test(text);

  function makePhrase(text, stopwords) {
    const normalized = normalizeText(text);
    const tokens = tokenize(text);
    const content = tokens.filter((token) => !stopwords.has(token));
    return {
      text,
      normalized,
      tokens,
      /* A phrase of nothing but function words ("do you do") matches everything and means nothing.
       * Falling back to the full token list there would resurrect exactly the false positives the
       * stopword list exists to remove, so such a phrase is left with no content and scores zero. */
      content,
      spaceless: SPACELESS_PHRASE(normalized),
    };
  }

  /**
   * Assemble every matchable candidate: the business's own FAQs, plus the locale's built-in intents
   * for facts that live in structured fields. Intents are appended last and marked, so a business FAQ
   * always outranks a built-in phrasing at equal score.
   */
  function buildCandidates(business, locale) {
    const stopwords = new Set((locale?.stopwords ?? []).map((word) => normalizeText(word)));
    const candidates = [];
    const faqs = Array.isArray(business.faqs) ? business.faqs : [];
    faqs.forEach((faq, index) => {
      if (!faq || typeof faq.q !== "string" || typeof faq.a !== "string") return;
      candidates.push({
        id: faq.id ?? `faq-${index}`,
        kind: "faq",
        question: faq.q,
        /* The answer is never matched against. Matching answers is how a bot ends up replying about
         * its opening hours because the word "hours" happened to appear in a sentence about parking. */
        phrases: [...phrasesOf(faq.q), ...(faq.keywords ?? []).filter((k) => typeof k === "string")].map((text) =>
          makePhrase(text, stopwords),
        ),
        answer: faq.a,
        source: `faq:${faq.id ?? index}`,
      });
    });
    const intents = locale?.intents ?? {};
    for (const [name, phrases] of Object.entries(intents)) {
      if (!Array.isArray(phrases) || phrases.length === 0) continue;
      candidates.push({
        id: `intent-${name}`,
        kind: "intent",
        intent: name,
        phrases: phrases.filter((p) => typeof p === "string").map((text) => makePhrase(text, stopwords)),
        source: `intent:${name}`,
      });
    }
    return { candidates, stopwords };
  }

  /** Inverse document frequency over the candidate set, in the BM25 form so a token present in most
   * candidates falls close to zero rather than merely being discounted. It refines the weighting; the
   * locale's stopword list, not this, is what removes function words. */
  function inverseDocumentFrequency(candidates) {
    const df = new Map();
    for (const candidate of candidates) {
      const seen = new Set();
      for (const phrase of candidate.phrases) for (const token of phrase.content) seen.add(token);
      for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const total = Math.max(candidates.length, 1);
    const idf = new Map();
    let max = 0;
    for (const [token, count] of df) {
      const value = Math.log(1 + (total - count + 0.5) / (count + 0.5));
      idf.set(token, value);
      if (value > max) max = value;
    }
    return { idf, ceiling: max || 1 };
  }

  /** Longest common substring length. Used only for scripts that do not separate words, where a
   * shared run of characters is a better signal than any token overlap. */
  function longestCommonSubstring(a, b) {
    if (!a || !b) return 0;
    let previous = new Array(b.length + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= a.length; i += 1) {
      const row = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          row[j] = previous[j - 1] + 1;
          if (row[j] > best) best = row[j];
        }
      }
      previous = row;
    }
    return best;
  }

  function scorePhrase(query, phrase, weights) {
    if (phrase.spaceless) {
      /* How much of this phrase appears verbatim inside the question. A two-character run is noise in
       * Japanese, so short accidental overlaps are refused outright. */
      const shared = longestCommonSubstring(query.normalized, phrase.normalized);
      if (shared < 2 || shared < phrase.normalized.length * 0.5) return 0;
      return shared / phrase.normalized.length;
    }
    if (phrase.content.length === 0 || query.content.length === 0) return 0;
    const { idf, ceiling } = weights;
    const weightOf = (token) => idf.get(token) ?? ceiling;

    const matchedPhraseTokens = new Set();
    let recallHit = 0;
    let recallTotal = 0;
    for (const qt of query.content) {
      const weight = weightOf(qt);
      recallTotal += weight;
      let hit = false;
      for (const ct of phrase.content) {
        if (!tokensMatch(qt, ct)) continue;
        matchedPhraseTokens.add(ct);
        hit = true;
      }
      if (hit) recallHit += weight;
    }
    let precisionHit = 0;
    let precisionTotal = 0;
    for (const ct of new Set(phrase.content)) {
      const weight = weightOf(ct);
      precisionTotal += weight;
      if (matchedPhraseTokens.has(ct)) precisionHit += weight;
    }
    const recall = recallTotal === 0 ? 0 : recallHit / recallTotal;
    const precision = precisionTotal === 0 ? 0 : precisionHit / precisionTotal;
    if (recall === 0 || precision === 0) return 0;
    return (2 * recall * precision) / (recall + precision);
  }

  function scoreCandidate(query, candidate, weights) {
    let best = 0;
    for (const phrase of candidate.phrases) {
      const score = scorePhrase(query, phrase, weights);
      if (score > best) best = score;
    }
    return best;
  }

  /* ---------------------------------------------------------------------------------------------
   * Answer construction
   * ------------------------------------------------------------------------------------------ */

  /** Fill `{name}` style slots from a value bag. A slot with no value leaves the template unusable,
   * which is deliberate -- a half-filled sentence is worse than no sentence. */
  function fillTemplate(template, values) {
    if (typeof template !== "string") return null;
    let missing = false;
    const filled = template.replace(/\{(\w+)\}/g, (_, key) => {
      const value = values[key];
      if (value === undefined || value === null || value === "") {
        missing = true;
        return "";
      }
      return String(value);
    });
    return missing ? null : filled;
  }

  function listServices(business) {
    const services = business.services;
    if (!Array.isArray(services) || services.length === 0) return null;
    return services.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean);
  }

  /**
   * Turn a won intent into an answer, or into `null` when the business never supplied that fact.
   * Rule 2 lives here: the return of `null` is what makes "we recognised your question but cannot
   * answer it" a first-class outcome instead of an invitation to improvise.
   */
  function answerFromField(intent, business, locale) {
    const templates = locale?.answers ?? {};
    switch (intent) {
      case "hours": {
        const hours = business.hours;
        if (!hours) return null;
        const text = typeof hours === "string" ? hours : formatHours(hours, locale);
        if (!text) return null;
        return { text: fillTemplate(templates.hours, { hours: text }) ?? text, source: "field:hours" };
      }
      case "address": {
        if (!business.address) return null;
        return {
          text: fillTemplate(templates.address, { address: business.address }) ?? business.address,
          source: "field:address",
        };
      }
      case "phone": {
        if (!business.phone) return null;
        return {
          text: fillTemplate(templates.phone, { phone: business.phone }) ?? business.phone,
          source: "field:phone",
        };
      }
      case "email": {
        if (!business.email) return null;
        return {
          text: fillTemplate(templates.email, { email: business.email }) ?? business.email,
          source: "field:email",
        };
      }
      case "website": {
        if (!business.website) return null;
        return {
          text: fillTemplate(templates.website, { website: business.website }) ?? business.website,
          source: "field:website",
        };
      }
      case "services": {
        const services = listServices(business);
        if (!services) return null;
        const joined = services.join(locale?.listSeparator ?? ", ");
        return {
          text: fillTemplate(templates.services, { services: joined }) ?? joined,
          source: "field:services",
        };
      }
      case "pricing": {
        if (!business.pricing) return null;
        return {
          text: fillTemplate(templates.pricing, { pricing: business.pricing }) ?? business.pricing,
          source: "field:pricing",
        };
      }
      default:
        return null;
    }
  }

  /** `{ mon: "9-5", ... }` rendered with the locale's own day names, or `null` if it has none. */
  function formatHours(hours, locale) {
    const dayNames = locale?.days;
    if (!dayNames) return null;
    const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const parts = [];
    for (const day of order) {
      const value = hours[day];
      if (!value) continue;
      const label = dayNames[day];
      if (!label) return null;
      parts.push(`${label}: ${value}`);
    }
    return parts.length > 0 ? parts.join(locale?.listSeparator ?? ", ") : null;
  }

  /**
   * The handoff buttons. Every action is derived from a contact field the business actually filled
   * in, so a business with no WhatsApp simply has no WhatsApp button -- there is no placeholder and
   * no dead link.
   */
  function buildActions(business, locale) {
    const labels = locale?.actions ?? {};
    const actions = [];
    if (business.phone && labels.call) {
      actions.push({ id: "call", label: labels.call, href: `tel:${business.phone.replace(/[^\d+]/g, "")}` });
    }
    if (business.whatsapp && labels.whatsapp) {
      actions.push({
        id: "whatsapp",
        label: labels.whatsapp,
        href: `https://wa.me/${business.whatsapp.replace(/[^\d]/g, "")}`,
      });
    }
    if (business.email && labels.email) {
      actions.push({ id: "email", label: labels.email, href: `mailto:${business.email}` });
    }
    if (business.contactUrl && labels.contact) {
      actions.push({ id: "contact", label: labels.contact, href: business.contactUrl });
    } else if (business.website && labels.website) {
      actions.push({ id: "website", label: labels.website, href: business.website });
    }
    return actions;
  }

  /* ---------------------------------------------------------------------------------------------
   * The engine
   * ------------------------------------------------------------------------------------------ */

  /**
   * Build an engine for one business in one locale.
   *
   * The returned object is pure: `ask` is a function of its argument and the config, with no clock,
   * no randomness and no I/O, which is why the tests can assert exact strings.
   */
  function createEngine({ business, locale, options = {} } = {}) {
    if (!business || typeof business !== "object") throw new TypeError("business config is required");
    if (!locale || typeof locale !== "object") throw new TypeError("locale pack is required");
    const tuning = { ...DEFAULTS, ...options };
    const { candidates, stopwords } = buildCandidates(business, locale);
    const weights = inverseDocumentFrequency(candidates);
    const actions = buildActions(business, locale);

    function greeting() {
      const text =
        business.greeting ??
        fillTemplate(locale.greeting, { name: business.name }) ??
        locale.greetingGeneric ??
        null;
      return text ? { kind: "greeting", text, source: business.greeting ? "business:greeting" : "locale:greeting", actions } : null;
    }

    function suggestions() {
      const faqs = Array.isArray(business.faqs) ? business.faqs : [];
      return faqs.slice(0, tuning.maxChoices).map((faq, index) => ({
        id: faq.id ?? `faq-${index}`,
        label: faq.q,
      }));
    }

    function ask(query) {
      const asked = makePhrase(String(query ?? ""), stopwords);
      if (asked.tokens.length === 0) {
        return { kind: "unknown", reason: "empty", text: locale.unknown, source: "locale:unknown", actions, score: 0 };
      }
      const scored = candidates
        .map((candidate) => ({ candidate, score: scoreCandidate(asked, candidate, weights) }))
        .filter((row) => row.score > 0)
        /* FAQs win ties against built-in intents: a business that wrote its own answer meant it. */
        .sort((a, b) =>
          b.score - a.score ||
          (a.candidate.kind === b.candidate.kind ? 0 : a.candidate.kind === "faq" ? -1 : 1) ||
          (a.candidate.id < b.candidate.id ? -1 : 1));

      const best = scored[0];
      if (!best || best.score < tuning.minScore) {
        return {
          kind: "unknown",
          reason: best ? "below-threshold" : "no-match",
          text: locale.unknown,
          source: "locale:unknown",
          actions,
          score: best?.score ?? 0,
          suggestions: suggestions(),
        };
      }

      const runnerUp = scored[1];
      if (runnerUp && best.score - runnerUp.score < tuning.minMargin) {
        /* Two facts fit the question about equally well. Picking one would be a coin flip presented
         * as an answer, so the visitor is shown the choices instead. */
        const choices = scored
          .filter((row) => best.score - row.score < tuning.minMargin)
          .slice(0, tuning.maxChoices)
          .map((row) => ({ id: row.candidate.id, label: labelFor(row.candidate, locale), score: row.score }));
        if (choices.length > 1) {
          return { kind: "choice", text: locale.disambiguate ?? locale.unknown, source: "locale:disambiguate", choices, actions, score: best.score };
        }
      }

      return resolve(best.candidate, best.score);
    }

    function labelFor(candidate, pack) {
      if (candidate.kind === "faq") return candidate.question;
      return pack?.intentLabels?.[candidate.intent] ?? candidate.intent;
    }

    function resolve(candidate, score) {
      if (candidate.kind === "faq") {
        return { kind: "answer", text: candidate.answer, source: candidate.source, actions, score, matchedId: candidate.id };
      }
      const field = answerFromField(candidate.intent, business, locale);
      if (!field) {
        /* Rule 2. The question was understood and the business never supplied the fact. Saying so is
         * the product working, not the product failing. */
        return {
          kind: "unknown",
          reason: "recognised-but-unanswerable",
          intent: candidate.intent,
          text: locale.unknown,
          source: "locale:unknown",
          actions,
          score,
          suggestions: suggestions(),
        };
      }
      return { kind: "answer", text: field.text, source: field.source, actions, score, matchedId: candidate.id };
    }

    /** Answer a suggestion chip by id, with no matching involved. */
    function answerById(id) {
      const candidate = candidates.find((row) => row.id === id);
      if (!candidate) return null;
      return resolve(candidate, 1);
    }

    return {
      ask,
      answerById,
      greeting,
      suggestions,
      actions,
      /* Exposed for the build tools and tests; not part of the buyer-facing surface. */
      _candidates: candidates,
    };
  }

  /**
   * Presentation. The engine decides what to say; this file decides how it looks and how it is
   * operated.
   *
   * Two things are deliberate here.
   *
   * The first is that everything worth asserting is a pure function -- `buildStyles`, `viewModel`,
   * `escapeHtml` -- and only the last third of the file touches the DOM. A widget whose logic can
   * only be exercised in a browser is a widget nobody tests, and this one has to survive being cloned
   * into hundreds of customer sites in nine languages without a browser in the loop for each.
   *
   * The second is that the custom-element registration is guarded. Importing this module in Node
   * (which the tests do) must not throw for want of `HTMLElement`, and must not register anything.
   *
   * Accessibility is not a later pass. The transcript is a live region, the launcher reports its
   * expanded state, focus moves into the panel on open and back to the launcher on close, Escape
   * closes, and every animation is behind `prefers-reduced-motion`. Right-to-left is a `dir`
   * attribute driven by the locale pack, not a separate stylesheet.
   */


  const ELEMENT_NAME = "website-chat-bot";

  /* ---------------------------------------------------------------------------------------------
   * Pure presentation
   * ------------------------------------------------------------------------------------------ */

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /** Business text is customer data, and customer data reaches the page as text, never as markup. */
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function tokenBlock(tokens) {
    return Object.entries(tokens)
      .map(([key, value]) => `    --wcb-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${value};`)
      .join("\n");
  }

  /**
   * Turn a theme pack into the widget's stylesheet.
   *
   * Every visual decision is a custom property, which is what makes three themes -- or a customer's
   * own colours in the $10 tier -- a config change rather than a code fork. The dark-mode block
   * redefines only the tokens the theme overrides, so a theme that says nothing about dark mode still
   * renders correctly instead of inheriting a half-applied palette.
   */
  function buildStyles(theme, { direction = "ltr" } = {}) {
    const tokens = theme?.tokens ?? {};
    const dark = theme?.dark ?? {};
    const start = direction === "rtl" ? "right" : "left";
    const end = direction === "rtl" ? "left" : "right";
    return `:host {
  ${tokenBlock(tokens)}
      --wcb-motion: 160ms;
      all: initial;
      font-family: var(--wcb-font);
      color: var(--wcb-text);
      position: fixed;
      bottom: 16px;
      inset-inline-${start === "right" ? "start" : "start"}: auto;
      inset-inline-end: 16px;
      z-index: 2147483000;
      direction: ${direction};
    }
    @media (prefers-color-scheme: dark) {
      :host {
  ${tokenBlock(dark)}
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host { --wcb-motion: 0ms; }
    }
    * { box-sizing: border-box; }
    button { font: inherit; cursor: pointer; }
    .launcher {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px;
      border: 1px solid var(--wcb-border);
      border-radius: var(--wcb-radius-launcher);
      background: var(--wcb-accent);
      color: var(--wcb-accent-text);
      box-shadow: var(--wcb-shadow);
      transition: transform var(--wcb-motion) ease-out;
    }
    .launcher:hover { transform: translateY(-1px); }
    .launcher:focus-visible { outline: 3px solid var(--wcb-accent); outline-offset: 3px; }
    .panel {
      display: none;
      flex-direction: column;
      width: min(380px, calc(100vw - 32px));
      height: min(540px, calc(100vh - 96px));
      background: var(--wcb-surface);
      border: 1px solid var(--wcb-border);
      border-radius: var(--wcb-radius);
      box-shadow: var(--wcb-shadow);
      overflow: hidden;
    }
    .panel[data-open="true"] { display: flex; }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px;
      background: var(--wcb-accent);
      color: var(--wcb-accent-text);
    }
    .head h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .close {
      border: 0;
      background: transparent;
      color: inherit;
      padding: 6px 8px;
      border-radius: var(--wcb-radius);
      line-height: 1;
    }
    .close:focus-visible { outline: 2px solid var(--wcb-accent-text); outline-offset: 2px; }
    .log {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--wcb-surface);
    }
    .msg { max-width: 86%; padding: 10px 12px; border-radius: var(--wcb-radius); line-height: 1.45; font-size: 14px; }
    .msg.bot { background: var(--wcb-bubble-bot); color: var(--wcb-text); align-self: flex-start; }
    .msg.user { background: var(--wcb-bubble-user); color: var(--wcb-bubble-user-text); align-self: flex-end; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border: 1px solid var(--wcb-border);
      background: var(--wcb-surface-alt);
      color: var(--wcb-text);
      border-radius: var(--wcb-radius-launcher);
      padding: 7px 11px;
      font-size: 13px;
      text-align: ${start};
    }
    .chip:focus-visible { outline: 2px solid var(--wcb-accent); outline-offset: 2px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
    .action {
      display: inline-block;
      text-decoration: none;
      border: 1px solid var(--wcb-accent);
      color: var(--wcb-accent);
      border-radius: var(--wcb-radius-launcher);
      padding: 7px 11px;
      font-size: 13px;
    }
    .action:focus-visible { outline: 2px solid var(--wcb-accent); outline-offset: 2px; }
    form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--wcb-border); background: var(--wcb-surface-alt); }
    input[type="text"] {
      flex: 1 1 auto;
      min-width: 0;
      padding: 10px 12px;
      font: inherit;
      font-size: 16px;
      color: var(--wcb-text);
      background: var(--wcb-surface);
      border: 1px solid var(--wcb-border);
      border-radius: var(--wcb-radius);
    }
    input[type="text"]:focus-visible { outline: 2px solid var(--wcb-accent); outline-offset: 1px; }
    .send { border: 1px solid var(--wcb-accent); background: var(--wcb-accent); color: var(--wcb-accent-text); border-radius: var(--wcb-radius); padding: 10px 14px; }
    .send:focus-visible { outline: 3px solid var(--wcb-accent); outline-offset: 2px; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    /* Phones: the panel takes the screen rather than floating in a corner it does not fit. The
       16px input font size above is what stops iOS Safari zooming the page on focus. */
    @media (max-width: 480px) {
      :host { inset: auto 8px 8px 8px; }
      .panel { width: calc(100vw - 16px); height: min(72vh, calc(100vh - 72px)); }
      .launcher { width: 100%; justify-content: center; }
    }
    @media (forced-colors: active) {
      .launcher, .panel, .chip, .action, .send { border: 1px solid CanvasText; }
    }`;
  }

  /**
   * The conversation as data.
   *
   * `entries` are `{ role, text, source }`. Keeping `source` on every bot turn all the way to the
   * view is what lets a test assert that nothing reached the screen without provenance.
   */
  function viewModel({ entries, suggestions, actions, locale }) {
    return {
      dir: locale?.direction ?? "ltr",
      title: locale?.ui?.title ?? "",
      placeholder: locale?.ui?.placeholder ?? "",
      sendLabel: locale?.ui?.send ?? "",
      openLabel: locale?.ui?.launcherOpen ?? locale?.ui?.launcher ?? "",
      closeLabel: locale?.ui?.launcherClose ?? "",
      launcherLabel: locale?.ui?.launcher ?? "",
      transcriptLabel: locale?.ui?.transcriptLabel ?? "",
      suggestionsLabel: locale?.ui?.suggestionsLabel ?? "",
      entries: entries.map((entry) => ({ ...entry })),
      suggestions: suggestions ?? [],
      actions: actions ?? [],
    };
  }

  /* ---------------------------------------------------------------------------------------------
   * The element
   * ------------------------------------------------------------------------------------------ */

  /** Read the page-level config. One global object is the whole integration contract for a buyer. */
  function readGlobalConfig(scope) {
    const host = scope ?? (typeof globalThis === "undefined" ? undefined : globalThis);
    const config = host?.WEBSITE_CHAT_BOT;
    if (!config || typeof config !== "object") return null;
    if (!config.business || !config.locale) return null;
    return config;
  }

  function defineElement(base) {
    return class WebsiteChatBot extends base {
      static observedAttributes = [];

      constructor() {
        super();
        this._open = false;
        this._entries = [];
        this._config = null;
        this._engine = null;
        this.attachShadow({ mode: "open" });
      }

      set config(value) {
        this._config = value;
        this._engine = createEngine({ business: value.business, locale: value.locale, options: value.options });
        this._entries = [];
        const greeting = this._engine.greeting();
        if (greeting) this._entries.push({ role: "bot", text: greeting.text, source: greeting.source });
        this._render();
      }

      get config() {
        return this._config;
      }

      connectedCallback() {
        if (!this._config) {
          const global = readGlobalConfig();
          if (global) this.config = global;
          else this._render();
        }
      }

      _say(role, text, source) {
        this._entries.push({ role, text, source });
      }

      _submit(query) {
        const trimmed = String(query ?? "").trim();
        if (trimmed === "") return;
        this._say("user", trimmed, "visitor");
        const result = this._engine.ask(trimmed);
        this._say("bot", result.text, result.source);
        this._last = result;
        this._render();
        this._focusInput();
      }

      _chose(id) {
        const result = this._engine.answerById(id);
        if (!result) return;
        this._say("bot", result.text, result.source);
        this._last = result;
        this._render();
        this._focusInput();
      }

      _focusInput() {
        const input = this.shadowRoot.querySelector('input[type="text"]');
        if (input) input.focus();
        const log = this.shadowRoot.querySelector(".log");
        if (log) log.scrollTop = log.scrollHeight;
      }

      _toggle(open) {
        this._open = open;
        this._render();
        if (open) this._focusInput();
        else {
          const launcher = this.shadowRoot.querySelector(".launcher");
          if (launcher) launcher.focus();
        }
      }

      _render() {
        const root = this.shadowRoot;
        if (!this._config) {
          root.innerHTML = "";
          return;
        }
        const { locale, theme } = this._config;
        const suggestions = this._last?.choices ?? this._last?.suggestions ?? this._engine.suggestions();
        const model = viewModel({
          entries: this._entries,
          suggestions,
          actions: this._engine.actions,
          locale,
        });
        root.innerHTML = `<style>${buildStyles(theme ?? {}, { direction: model.dir })}</style>
  <button class="launcher" type="button" aria-expanded="${this._open}" aria-controls="wcb-panel">
    <span aria-hidden="true">💬</span><span>${escapeHtml(model.launcherLabel)}</span>
  </button>
  <section class="panel" id="wcb-panel" data-open="${this._open}" role="dialog" aria-modal="false" aria-label="${escapeHtml(model.title)}" dir="${model.dir}">
    <div class="head">
      <h2>${escapeHtml(model.title)}</h2>
      <button class="close" type="button" aria-label="${escapeHtml(model.closeLabel)}">✕</button>
    </div>
    <div class="log" role="log" aria-live="polite" aria-label="${escapeHtml(model.transcriptLabel)}">
      ${model.entries
        .map((entry) => `<p class="msg ${entry.role === "user" ? "user" : "bot"}" data-source="${escapeHtml(entry.source)}">${escapeHtml(entry.text)}</p>`)
        .join("\n    ")}
      ${
        model.suggestions.length > 0
          ? `<div class="chips" role="group" aria-label="${escapeHtml(model.suggestionsLabel)}">${model.suggestions
              .map((s) => `<button class="chip" type="button" data-id="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>`)
              .join("")}</div>`
          : ""
      }
    </div>
    ${
      model.actions.length > 0
        ? `<div class="actions">${model.actions
            .map((a) => `<a class="action" href="${escapeHtml(a.href)}" rel="noopener">${escapeHtml(a.label)}</a>`)
            .join("")}</div>`
        : ""
    }
    <form>
      <label class="sr-only" for="wcb-input">${escapeHtml(model.placeholder)}</label>
      <input id="wcb-input" type="text" autocomplete="off" placeholder="${escapeHtml(model.placeholder)}" />
      <button class="send" type="submit">${escapeHtml(model.sendLabel)}</button>
    </form>
  </section>`;

        root.querySelector(".launcher").addEventListener("click", () => this._toggle(!this._open));
        root.querySelector(".close").addEventListener("click", () => this._toggle(false));
        root.querySelector("form").addEventListener("submit", (event) => {
          event.preventDefault();
          const input = root.querySelector('input[type="text"]');
          const value = input.value;
          input.value = "";
          this._submit(value);
        });
        for (const chip of root.querySelectorAll(".chip")) {
          chip.addEventListener("click", () => this._chose(chip.dataset.id));
        }
        root.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && this._open) this._toggle(false);
        });
      }
    };
  }

  /** Register the element and auto-mount from `window.WEBSITE_CHAT_BOT`, if there is a DOM. */
  function install(scope = globalThis) {
    if (typeof scope?.HTMLElement !== "function" || !scope.customElements) return false;
    if (!scope.customElements.get(ELEMENT_NAME)) {
      scope.customElements.define(ELEMENT_NAME, defineElement(scope.HTMLElement));
    }
    const config = readGlobalConfig(scope);
    if (config && scope.document && !scope.document.querySelector(ELEMENT_NAME)) {
      const element = scope.document.createElement(ELEMENT_NAME);
      scope.document.body.appendChild(element);
      element.config = config;
    }
    return true;
  }

  /* Auto-install on import in a browser; a no-op under Node, which is what the tests rely on. */
  install();

})();
