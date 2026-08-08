/**
 * Minimal YAML front-matter parser — enough for Obsidian note front matter.
 *
 * Supported:
 *   - block mappings and nested block mappings;
 *   - block sequences ( "- item" );
 *   - scalar values: plain, single-quoted, double-quoted;
 *   - booleans, numbers (int/float), null;
 *   - inline flow sequences/maps ([...], {...}) for common simple cases;
 *   - comments on their own line.
 *
 * Not supported (fail-closed — throws so the note is not treated as verified):
 *   - anchors/aliases, merge keys, multi-line block scalars, tags,
 *     complex flow constructs.  Such front matter is rejected rather than
 *     mis-canonicalized.
 */

export class YamlError extends Error {
  constructor(message) {
    super(message);
    this.name = "YamlError";
  }
}

const INDENT_RE = /^( *)/u;

// Keys that are dangerous or ambiguous in a mapping (F-06 / plan §38). Reject
// them so front matter can never be a prototype-pollution or merge-key vector.
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor", ""]);

function safeKey(key, context) {
  if (UNSAFE_KEYS.has(key)) {
    throw new YamlError(`unsafe mapping key ${JSON.stringify(key)}${context ? ` in ${context}` : ""}`);
  }
  // Any YAML tag introducer in a key position is rejected.
  if (/^!/.test(key) || /^&/.test(key) || /^\*/.test(key)) {
    throw new YamlError(`tag/anchor/alias keys are not supported: ${JSON.stringify(key)}`);
  }
  if (/^\[.*\]$/.test(key) || /^\{.*\}$/.test(key)) {
    throw new YamlError(`complex mapping keys are not supported: ${JSON.stringify(key)}`);
  }
  return key;
}

// Fail-closed guard for the naive flow parser (GP6-02 + GP7-05 + GP8-04). The
// parser splits flow collections with split(","), which is only correct for
// flat, unquoted items. Reject (rather than silently mis-split) when:
//   - a comma sits inside a quoted item (GP6-02), or
//   - the flow collection nests to depth > 1 (GP7-05), or
//   - the flow is unbalanced: brackets/braces do not close, or a quote stays
//     open, by the end of the collection (GP8-04).
// inner is the content INSIDE the enclosing [..] / {..}, so it starts at
// depth 1; any `[` or `{` pushes it to 2 = nested = unsupported, and a `]`/`}`
// that drops it below 1 means the enclosing collection itself is unbalanced.
function rejectUnsupportedFlow(inner) {
  let inSingle = false;
  let inDouble = false;
  let depth = 1;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === "'" && !inDouble) {
      if (inSingle && inner[i + 1] === "'") {
        i += 1; // '' is an escaped single quote inside single quotes
        continue;
      }
      inSingle = !inSingle;
    } else if (c === '"' && !inSingle) {
      if (inDouble && inner[i - 1] === "\\") continue; // \" stays inside
      inDouble = !inDouble;
    } else if (inSingle || inDouble) {
      if (c === ",") {
        throw new YamlError("commas inside quoted flow items are not supported");
      }
    } else if (c === "[" || c === "{") {
      depth += 1;
      if (depth > 1) {
        throw new YamlError("nested flow collections are not supported");
      }
    } else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth < 1) {
        throw new YamlError("unbalanced flow collection");
      }
    }
  }
  if (depth !== 1) {
    throw new YamlError("unbalanced flow collection");
  }
  if (inSingle || inDouble) {
    throw new YamlError("unterminated quote in flow collection");
  }
}

// Reject YAML merge key `<<` at any position of a mapping line.
function rejectMergeKey(text) {
  if (text.startsWith("<<") && (text.length === 2 || /^<<[\s:]/.test(text))) {
    throw new YamlError("YAML merge keys (<<) are not supported");
  }
}

// Reject explicit tags (`!!tag`, `!tag`, `!<tag:...>`) and anchors/aliases
// (`&a`, `*a`) in scalar or value position. Any leading `!` is a tag
// introducer in YAML; reject all of them rather than whitelist patterns.
function rejectTag(text) {
  if (text.startsWith("!")) {
    throw new YamlError(`YAML tags are not supported: ${JSON.stringify(text)}`);
  }
  if (text.startsWith("&") || text.startsWith("*")) {
    throw new YamlError(`YAML anchors/aliases are not supported: ${JSON.stringify(text)}`);
  }
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true" || text === "True") return true;
  if (text === "false" || text === "False") return false;
  rejectTag(text);
  // Quoted scalar with an optional trailing comment: "alpha" # comment. A
  // comment may follow a completed quoted scalar. Anything else trailing a
  // closed quote is a malformed/unsupported construct and fails closed
  // (GP8-04): previously `"alpha" # comment` fell through to the raw-text
  // return and silently kept the quotes and comment in the value.
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    // The closing quote is the LAST occurrence (the escaped `\"` inside a
    // double-quoted scalar keeps its backslash, and `''` inside single quotes
    // stays literal). Anything after the last quote must be empty or a
    // comment; otherwise fail closed (GP8-04) — previously `"alpha" # comment`
    // silently kept the quotes+comment in the value.
    const close = text.lastIndexOf(quote);
    if (close <= 0) {
      throw new YamlError("unterminated quoted scalar");
    }
    const rest = text.slice(close + 1).trim();
    if (rest !== "" && !rest.startsWith("#")) {
      throw new YamlError("unexpected content after quoted scalar");
    }
    const body = text.slice(1, close);
    if (quote === '"') return body.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    return body.replace(/''/gu, "'");
  }
  if (/^[-+]?\d+$/u.test(text)) {
    const num = Number(text);
    if (Number.isSafeInteger(num)) return num;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/u.test(text)) return Number(text);
  // Flow sequence [a, b, c] — must be balanced (GP8-04).
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) {
      throw new YamlError("unbalanced flow sequence");
    }
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    rejectUnsupportedFlow(inner);
    return inner.split(",").map((item) => parseScalar(item));
  }
  // Flow map {k: v, ...} — must be balanced (GP8-04).
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) {
      throw new YamlError("unbalanced flow map");
    }
    const inner = text.slice(1, -1).trim();
    if (inner === "") return {};
    rejectUnsupportedFlow(inner);
    // Object.create(null): __proto__/constructor keys must not land on a
    // prototype chain. Keys also go through safeKey so tags/anchors/complex
    // keys are rejected.
    const out = Object.create(null);
    for (const pair of inner.split(",")) {
      const idx = pair.indexOf(":");
      if (idx < 0) throw new YamlError("invalid flow map entry");
      const rawKey = parseScalar(pair.slice(0, idx)).toString();
      const key = safeKey(rawKey, "flow map");
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new YamlError(`duplicate key in flow map: ${key}`);
      }
      out[key] = parseScalar(pair.slice(idx + 1));
    }
    return out;
  }
  return text;
}

/**
 * Parse a front-matter block (the raw text between the --- fences).
 * Returns a plain object.  Throws YamlError on unsupported/unparsable input.
 */
export function parseFrontMatterYaml(text) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const root = Object.create(null);
  const stack = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // GP6-02: YAML forbids tab for indentation anywhere in the leading
    // whitespace. A tab at column 0 OR after spaces (`  \tchild`) is ambiguous
    // and must fail closed — checking only column 0 let `  \tchild` be
    // re-indented and accepted as a nested key.
    const leading = /^[ \t]*/u.exec(line)?.[0] ?? "";
    if (leading.includes("\t")) {
      throw new YamlError("tab indentation is not supported");
    }
    const indentMatch = INDENT_RE.exec(line);
    const indent = indentMatch[1].length;
    const content = line.slice(indent);
    const trimmed = content.trim();

    if (trimmed.startsWith("- ")) {
      // Block sequence item under the current container.
      const parent = stack[stack.length - 1].obj;
      const itemText = trimmed.slice(2);
      if (!Array.isArray(parent)) {
        throw new YamlError("block sequence item outside of a sequence");
      }
      rejectMergeKey(itemText);
      // Reject nested sequence-in-map structures for simplicity.
      parent.push(parseScalar(itemText));
      continue;
    }

    const colonIdx = content.indexOf(":");
    if (colonIdx < 0) throw new YamlError(`unparsable line: ${trimmed}`);
    const key = content.slice(0, colonIdx).trim();
    rejectMergeKey(trimmed);
    safeKey(key, "mapping");
    let valueText = content.slice(colonIdx + 1).trim();
    const isNested = valueText === "" || valueText.startsWith("#");

    // Pop the stack back to the correct parent for this indent.
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const container = stack[stack.length - 1].obj;
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      throw new YamlError("mapping entry outside of a mapping");
    }
    // Duplicate key → reject (never last-wins), F-06 / plan §39.
    if (Object.prototype.hasOwnProperty.call(container, key)) {
      throw new YamlError(`duplicate mapping key: ${key}`);
    }

    if (isNested) {
      // Peek the next non-empty line: a "- " under a deeper indent means this
      // key holds a block sequence.
      let peek = i + 1;
      while (peek < lines.length && (lines[peek].trim() === "" || lines[peek].trim().startsWith("#"))) {
        peek += 1;
      }
      const nextLine = peek < lines.length ? lines[peek] : "";
      const nextIndentMatch = INDENT_RE.exec(nextLine);
      const nextIndent = nextIndentMatch ? nextIndentMatch[1].length : -1;
      if (nextIndent > indent && nextLine.slice(nextIndent).trim().startsWith("- ")) {
        container[key] = [];
        stack.push({ indent, obj: container[key] });
      } else {
        const childObj = Object.create(null);
        container[key] = childObj;
        stack.push({ indent, obj: childObj });
      }
    } else {
      // Strip trailing comment (only when not inside quotes).
      if (!/^["']/u.test(valueText)) {
        const hashIdx = valueText.indexOf(" #");
        if (hashIdx >= 0) valueText = valueText.slice(0, hashIdx).trim();
      }
      rejectTag(valueText);
      container[key] = parseScalar(valueText);
    }
  }
  return root;
}
