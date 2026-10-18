/** The first `max` characters of the text, each outside printable ASCII escaped as `\uXXXX`, cut to `max` characters with `...` when anything is dropped. */
export function bounded(text: string, max = 80): string {
    const escaped = text.slice(0, max).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return text.length > max || escaped.length > max ? `${escaped.slice(0, max - 3)}...` : escaped;
}

const WALK_LIMIT = 1000;
const MAX_DEPTH = 8;

/** The first `WALK_LIMIT` characters of the string as JSON text. The rest is dropped. */
function quote(text: string): string {
    return JSON.stringify(text.slice(0, WALK_LIMIT));
}

/** Collects the rendering of a value, and stops adding once `WALK_LIMIT` characters are in. */
class Walk {
    private text = "";
    private readonly open = new Set<object>();

    get full(): boolean {
        return this.text.length >= WALK_LIMIT;
    }

    add(piece: string): void {
        if (!this.full) this.text += piece;
    }

    result(): string {
        return this.text;
    }

    value(value: unknown, depth: number): void {
        if (this.full) return;
        switch (typeof value) {
            case "string":
                return this.add(quote(value));
            case "number":
                return this.add(Object.is(value, -0) ? "-0" : String(value));
            case "bigint":
            case "boolean":
            case "undefined":
            case "symbol":
            case "function":
                return this.add(String(value));
        }
        if (value === null) return this.add("null");
        const object = value as object;
        if (this.open.has(object)) return this.add("[Circular]");
        if (depth >= MAX_DEPTH) return this.add("...");
        this.open.add(object);
        try {
            this.object(object, depth + 1);
        } finally {
            this.open.delete(object);
        }
    }

    private list(items: Iterable<unknown>, depth: number, open: string, close: string): void {
        this.add(open);
        let first = true;
        for (const item of items) {
            if (this.full) break;
            if (!first) this.add(",");
            first = false;
            this.value(item, depth);
        }
        this.add(close);
    }

    private object(object: object, depth: number): void {
        if (object instanceof Date) {
            return this.add(Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString());
        }
        if (object instanceof Error) return this.add(`${String(object.name)}: ${String(object.message)}`);
        if (object instanceof Number || object instanceof String || object instanceof Boolean) {
            this.add(`${object.constructor.name}(`);
            this.value(object.valueOf(), depth);
            return this.add(")");
        }
        if (Array.isArray(object)) return this.list(object, depth, "[", "]");
        if (ArrayBuffer.isView(object)) {
            const items = object instanceof DataView ? new Uint8Array(object.buffer, object.byteOffset, object.byteLength) : (object as unknown as ArrayLike<unknown>);
            return this.list(Array.prototype.values.call(items), depth, `${object.constructor.name}[`, "]");
        }
        if (object instanceof Map) {
            this.add("Map{");
            let first = true;
            for (const [k, v] of object) {
                if (this.full) break;
                if (!first) this.add(",");
                first = false;
                this.value(k, depth);
                this.add("=>");
                this.value(v, depth);
            }
            return this.add("}");
        }
        if (object instanceof Set) return this.list(object, depth, "Set{", "}");
        const proto = Object.getPrototypeOf(object);
        if (proto !== Object.prototype && proto !== null) this.add(String(proto.constructor?.name ?? "Object"));
        this.add("{");
        let first = true;
        for (const key of Object.keys(object)) {
            if (this.full) break;
            if (!first) this.add(",");
            first = false;
            this.add(`${quote(key)}:`);
            this.value((object as Record<string, unknown>)[key], depth);
        }
        this.add("}");
    }
}

/** The only way an error message quotes a value: any value as bounded, escaped text that cannot rewrite or flood the message. */
export function show(value: unknown): string {
    try {
        const walk = new Walk();
        walk.value(value, 0);
        return bounded(walk.result());
    } catch {
        return "[unprintable value]";
    }
}
