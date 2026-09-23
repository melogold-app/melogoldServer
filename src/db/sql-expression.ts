/**
 * Canonical form of the SQL expressions of the schema: `CHECK` constraints and partial-index predicates (API §9.1 rule
 * 5), for the schema check (`schema-check.ts`).
 *
 * The same expression reaches the check in three spellings:
 * - as written in the migration and stored verbatim by SQLite: `length(login) BETWEEN 3 AND 64`, `deleted IN (0,1)`;
 * - as PostgreSQL deparses it (`pg_get_constraintdef`, `pg_get_expr`): `((length(login) >= 3) AND (length(login) <= 64))`,
 *   `(deleted = ANY (ARRAY[0, 1]))`, `(video_id = '*'::text)`.
 *
 * {@link canonicalExpression} parses any of them and prints one form: brackets around every operation, `BETWEEN`
 * expanded to `>= AND <=`, `= ANY (ARRAY[…])` written as `IN (…)`, casts and `COLLATE` dropped, `!=` as `<>`,
 * nested `AND`/`OR` flattened, identifiers unquoted and lowercase. Two expressions are the same constraint when their
 * canonical forms are equal.
 */

export class SqlExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlExpressionError";
  }
}

type Node =
  | { kind: "column"; name: string }
  | { kind: "literal"; text: string }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "compare"; op: string; left: Node; right: Node }
  | { kind: "and" | "or"; items: Node[] }
  | { kind: "not"; item: Node }
  | { kind: "null"; item: Node; negated: boolean }
  | { kind: "in"; item: Node; list: Node[] }
  | { kind: "array"; items: Node[] };

type Token = Readonly<{ type: "string" | "quoted" | "number" | "word" | "op" | "punct"; text: string }>;

const TOKEN =
  /\s*(?:('(?:[^']|'')*')|("(?:[^"]|"")*")|(\d+)|([A-Za-z_][A-Za-z0-9_]*)|(::|<>|!=|<=|>=|=|<|>)|([()[\],]))/y;
const TOKEN_TYPES = ["string", "quoted", "number", "word", "op", "punct"] as const;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    if (/^\s*$/.test(text.slice(position))) break;
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(text);
    if (!match) throw new SqlExpressionError(`unsupported syntax at "${text.slice(position)}" in "${text}"`);
    position = TOKEN.lastIndex;
    // Exactly one group matched; the others are undefined at runtime (typed as string).
    const index = match.slice(1).findIndex((group: string | undefined) => group !== undefined);
    tokens.push({ type: TOKEN_TYPES[index] ?? "punct", text: match[index + 1] ?? "" });
  }
  return tokens;
}

/** Words that may follow the first word of a type name in a cast (`character varying`, `double precision`). */
const TYPE_CONTINUATIONS = new Set(["varying", "precision", "with", "without", "time", "zone"]);
const COMPARISONS = new Set(["=", "<>", "!=", "<", "<=", ">", ">="]);

class Parser {
  readonly #tokens: Token[];
  readonly #text: string;
  #position = 0;

  constructor(text: string) {
    this.#text = text;
    this.#tokens = tokenize(text);
  }

  parse(): Node {
    const node = this.#or();
    if (this.#position < this.#tokens.length) this.#fail("unexpected token");
    return node;
  }

  #fail(message: string): never {
    const near = this.#tokens[this.#position]?.text ?? "end of input";
    throw new SqlExpressionError(`${message} near "${near}" in "${this.#text}"`);
  }

  #peek(offset = 0): Token | undefined {
    return this.#tokens[this.#position + offset];
  }

  #isWord(token: Token | undefined, word: string): boolean {
    return token?.type === "word" && token.text.toUpperCase() === word;
  }

  #acceptWord(word: string): boolean {
    if (!this.#isWord(this.#peek(), word)) return false;
    this.#position++;
    return true;
  }

  #expectWord(word: string): void {
    if (!this.#acceptWord(word)) this.#fail(`expected ${word}`);
  }

  #acceptPunct(text: string): boolean {
    const token = this.#peek();
    if (token?.type !== "punct" || token.text !== text) return false;
    this.#position++;
    return true;
  }

  #expectPunct(text: string): void {
    if (!this.#acceptPunct(text)) this.#fail(`expected "${text}"`);
  }

  #or(): Node {
    const items = [this.#and()];
    while (this.#acceptWord("OR")) items.push(this.#and());
    return junction("or", items);
  }

  #and(): Node {
    const items = [this.#not()];
    while (this.#acceptWord("AND")) items.push(this.#not());
    return junction("and", items);
  }

  #not(): Node {
    if (this.#acceptWord("NOT")) return { kind: "not", item: this.#not() };
    return this.#predicate();
  }

  #list(close: string): Node[] {
    const items: Node[] = [];
    if (this.#acceptPunct(close)) return items;
    do items.push(this.#operand());
    while (this.#acceptPunct(","));
    this.#expectPunct(close);
    return items;
  }

  #predicate(): Node {
    const left = this.#operand();
    if (this.#acceptWord("IS")) {
      const negated = this.#acceptWord("NOT");
      this.#expectWord("NULL");
      return { kind: "null", item: left, negated };
    }
    const negated = this.#isWord(this.#peek(), "NOT") && ["BETWEEN", "IN"].some((w) => this.#isWord(this.#peek(1), w));
    if (negated) this.#position++;
    let node: Node | null = null;
    if (this.#acceptWord("BETWEEN")) {
      const low = this.#operand();
      this.#expectWord("AND");
      const high = this.#operand();
      node = junction("and", [
        { kind: "compare", op: ">=", left, right: low },
        { kind: "compare", op: "<=", left, right: high },
      ]);
    } else if (this.#acceptWord("IN")) {
      this.#expectPunct("(");
      node = { kind: "in", item: left, list: this.#list(")") };
    }
    if (node !== null) return negated ? { kind: "not", item: node } : node;
    const token = this.#peek();
    if (token?.type !== "op" || !COMPARISONS.has(token.text)) return left;
    this.#position++;
    const op = token.text === "!=" ? "<>" : token.text;
    if (op === "=" && this.#isWord(this.#peek(), "ANY")) {
      this.#position++;
      this.#expectPunct("(");
      const array = this.#operand();
      this.#expectPunct(")");
      if (array.kind !== "array") this.#fail("= ANY needs an ARRAY[…]");
      return { kind: "in", item: left, list: array.items };
    }
    return { kind: "compare", op, left, right: this.#operand() };
  }

  /** A value: literal, column, call, array or a bracketed expression, then any casts and `COLLATE`. */
  #operand(): Node {
    const token = this.#peek();
    if (token === undefined) this.#fail("unexpected end");
    this.#position++;
    let node: Node;
    if (token.type === "punct" && token.text === "(") {
      node = this.#or();
      this.#expectPunct(")");
    } else if (token.type === "string" || token.type === "number") {
      node = { kind: "literal", text: token.text };
    } else if (token.type === "quoted") {
      node = { kind: "column", name: token.text.slice(1, -1).replaceAll('""', '"').toLowerCase() };
    } else if (token.type === "word") {
      if (token.text.toUpperCase() === "ARRAY" && this.#acceptPunct("[")) {
        node = { kind: "array", items: this.#list("]") };
      } else if (this.#acceptPunct("(")) {
        node = { kind: "call", name: token.text.toLowerCase(), args: this.#list(")") };
      } else {
        node = { kind: "column", name: token.text.toLowerCase() };
      }
    } else {
      this.#position--;
      this.#fail("expected a value");
    }
    for (;;) {
      if (this.#peek()?.type === "op" && this.#peek()?.text === "::") {
        this.#position++;
        this.#skipTypeName();
      } else if (this.#acceptWord("COLLATE")) {
        const collation = this.#peek();
        if (collation?.type !== "quoted" && collation?.type !== "word") this.#fail("expected a collation");
        this.#position++;
      } else {
        return node;
      }
    }
  }

  #skipTypeName(): void {
    const first = this.#peek();
    if (first?.type !== "word" && first?.type !== "quoted") this.#fail("expected a type name");
    this.#position++;
    while (this.#peek()?.type === "word" && TYPE_CONTINUATIONS.has(this.#peek()?.text.toLowerCase() ?? "")) {
      this.#position++;
    }
    if (this.#acceptPunct("(")) this.#list(")");
    while (this.#peek()?.type === "punct" && this.#peek()?.text === "[" && this.#peek(1)?.text === "]") {
      this.#position += 2;
    }
  }
}

function junction(kind: "and" | "or", items: Node[]): Node {
  const flat = items.flatMap((item) => (item.kind === kind ? item.items : [item]));
  return flat.length === 1 && flat[0] !== undefined ? flat[0] : { kind, items: flat };
}

function print(node: Node): string {
  switch (node.kind) {
    case "column":
      return node.name;
    case "literal":
      return node.text;
    case "call":
      return `${node.name}(${node.args.map(print).join(", ")})`;
    case "compare":
      return `(${print(node.left)} ${node.op} ${print(node.right)})`;
    case "and":
    case "or":
      return `(${node.items.map(print).join(node.kind === "and" ? " AND " : " OR ")})`;
    case "not":
      return `(NOT ${print(node.item)})`;
    case "null":
      return `(${print(node.item)} IS ${node.negated ? "NOT " : ""}NULL)`;
    case "in":
      return `(${print(node.item)} IN (${node.list.map(print).join(", ")}))`;
    case "array":
      return `ARRAY[${node.items.map(print).join(", ")}]`;
  }
}

/**
 * The canonical form of a `CHECK` or `WHERE` expression, in any of the spellings above.
 * @throws SqlExpressionError for syntax outside the portable subset and PostgreSQL's deparsed form of it.
 */
export function canonicalExpression(text: string): string {
  return print(new Parser(text).parse());
}

/** {@link canonicalExpression}, or the text with collapsed whitespace when it cannot be parsed (never equal by luck). */
export function comparableExpression(text: string): string {
  try {
    return canonicalExpression(text);
  } catch {
    return `unparsed: ${text.replace(/\s+/g, " ").trim()}`;
  }
}

/** The index of the bracket that closes the one at `open`, skipping quoted text; `-1` when unbalanced. */
function closingBracket(sql: string, open: number): number {
  let depth = 0;
  for (let index = open; index < sql.length; index++) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === "`") {
      const end = sql.indexOf(char, index + 1);
      if (end < 0) return -1;
      index = end;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every `CHECK (…)` expression of a `CREATE TABLE` statement as SQLite stores it (`sqlite_schema.sql`). */
export function checkExpressions(createTable: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < createTable.length; index++) {
    const char = createTable[index];
    if (char === "'" || char === '"' || char === "`") {
      const end = createTable.indexOf(char, index + 1);
      if (end < 0) break;
      index = end;
      continue;
    }
    const match = /^CHECK\s*\(/i.exec(createTable.slice(index, index + 32));
    if (!match || /[A-Za-z0-9_]/.test(createTable[index - 1] ?? "")) continue;
    const open = index + match[0].length - 1;
    const close = closingBracket(createTable, open);
    if (close < 0) break;
    found.push(createTable.slice(open + 1, close).trim());
    index = close;
  }
  return found;
}

/** The `WHERE` expression of a `CREATE INDEX` statement as SQLite stores it, or `null` for a full index. */
export function partialIndexPredicate(createIndex: string): string | null {
  const open = createIndex.indexOf("(");
  if (open < 0) return null;
  const close = closingBracket(createIndex, open);
  if (close < 0) return null;
  const match = /^\s*WHERE\s+([\s\S]+)$/i.exec(createIndex.slice(close + 1));
  return match?.[1]?.trim() ?? null;
}
