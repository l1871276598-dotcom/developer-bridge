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
  if (/^[&*]/.test(key)) {
    throw new YamlError(`anchor/alias keys are not supported: ${JSON.stringify(key)}`);
  }
  if (/^\[.*\]$/.test(key) || /^\{.*\}$/.test(key)) {
    throw new YamlError(`complex mapping keys are not supported: ${JSON.stringify(key)}`);
  }
  return key;
}

// Reject YAML merge key `<<` at any position of a mapping line.
function rejectMergeKey(text) {
  if (text.startsWith("<<") && (text.length === 2 || /^<<[\s:]/.test(text))) {
    throw new YamlError("YAML merge keys (<<) are not supported");
  }
}

// Reject explicit tags (`!!tag`, `!tag`) and anchors/aliases (`&a`, `*a`)
// in scalar or value position.
function rejectTag(text) {
  if (/^!{1,2}[\w.-]+/.test(text)) {
    throw new YamlError(`YAML tags are not supported: ${JSON.stringify(text)}`);
  }
  if (/^&[\w.-]+/.test(text) || /^\*[\w.-]+/.test(text)) {
    throw new YamlError(`YAML anchors/aliases are not supported: ${JSON.stringify(text)}`);
  }
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true" || text === "True") return true;
  if (text === "false" || text === "False") return false;
  rejectTag(text);
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    const body = text.slice(1, -1);
    if (text.startsWith('"')) return body.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    return body.replace(/''/gu, "'");
  }
  if (/^[-+]?\d+$/u.test(text)) {
    const num = Number(text);
    if (Number.isSafeInteger(num)) return num;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/u.test(text)) return Number(text);
  // Flow sequence [a, b, c]
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  // Flow map {k: v, ...}
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return {};
    const out = {};
    for (const pair of inner.split(",")) {
      const idx = pair.indexOf(":");
      if (idx < 0) throw new YamlError("invalid flow map entry");
      const key = parseScalar(pair.slice(0, idx)).toString();
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
