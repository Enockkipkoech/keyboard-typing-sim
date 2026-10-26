
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import cron from "node-cron";

type KeyEventType = "keydown" | "keyup";

interface KeyboardEventLog {
    timestamp: string;
    elapsedMs: number;
    event: KeyEventType;
    key: string;
    code: string;
    synthetic: true;
}

interface Options {
    seed: number;
    typoRate: number;
    output: string;
    input: string;
    text: string;
}

function parseArgs(args: string[]): Options {
    const get = (name: string, fallback: string) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] ?? fallback : fallback;
    };

    const typoRate = Number(get("--typo-rate", "0.04"));
    const seed = Number(get("--seed", "42"));

    if (!Number.isFinite(seed) || !Number.isFinite(typoRate)) {
        throw new Error("Seed and typo rate must be numbers.");
    }

    if (typoRate < 0 || typoRate > 1) {
        throw new Error("--typo-rate must be between 0 and 1.");
    }

    const input = get("--input", "input.txt");

    return {
        seed,
        typoRate,
        input: resolve(input),
        output: resolve(get("--output", "logs/typing.jsonl")),
        text: "", // Loaded asynchronously in main().
    };
}


// Seeded PRNG: identical seed => identical random choices.
function createRandom(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

const keyboardRows = [
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
];

function adjacentTypo(char: string, random: () => number): string {
    const lower = char.toLowerCase();

    for (const row of keyboardRows) {
        const index = row.indexOf(lower);
        if (index < 0) continue;

        const neighbors = [
            row[index - 1],
            row[index + 1],
        ].filter((value): value is string => Boolean(value));

        if (neighbors.length === 0) return char;

        const replacement = neighbors[
            Math.floor(random() * neighbors.length)
        ];

        return char === char.toUpperCase()
            ? replacement.toUpperCase()
            : replacement;
    }

    return char;
}

function keyCode(key: string): string {
    if (/^[a-z]$/i.test(key)) {
        return `Key${key.toUpperCase()}`;
    }

    if (/^[0-9]$/.test(key)) {
        return `Digit${key}`;
    }

    const codes: Record<string, string> = {
        " ": "Space",
        ".": "Period",
        ",": "Comma",
        "!": "Digit1",
        "?": "Slash",
        "'": "Quote",
        '"': "Quote",
        "-": "Minus",
        ":": "Semicolon",
        ";": "Semicolon",
        "\n": "Enter",
        "\t": "Tab",
        Backspace: "Backspace",
    };

    return codes[key] ?? "Unidentified";
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));

    options.text = await readFile(options.input, "utf8");

    if (!options.text.trim()) {
        throw new Error(`Input file is empty: ${options.input}`);
    }

    console.log(`Input: ${options.input}`);
    console.log(`Characters: ${options.text.length}`);
    const random = createRandom(options.seed);
    const stream = createWriteStream(options.output, {
        encoding: "utf8",
    });

    const startTime = Date.now();
    let elapsedMs = 0;
    let eventCount = 0;

    function pause(min: number, max: number): void {
        elapsedMs += min + random() * (max - min);
    }

    async function emitKey(key: string): Promise<void> {
        const duration = 45 + random() * 100;

        const down: KeyboardEventLog = {
            timestamp: new Date(startTime + elapsedMs).toISOString(),
            elapsedMs: Math.round(elapsedMs),
            event: "keydown",
            key,
            code: keyCode(key),
            synthetic: true,
        };

        stream.write(`${JSON.stringify(down)}\n`);
        eventCount++;

        elapsedMs += duration;

        const up: KeyboardEventLog = {
            timestamp: new Date(startTime + elapsedMs).toISOString(),
            elapsedMs: Math.round(elapsedMs),
            event: "keyup",
            key,
            code: keyCode(key),
            synthetic: true,
        };

        if (!stream.write(`${JSON.stringify(up)}\n`)) {
            await once(stream, "drain");
        }
        eventCount++;

        // Small, variable delay before the next key.
        pause(25, 115);
    }

    for (let i = 0; i < options.text.length; i++) {
        const char = options.text[i];

        // Pause naturally around whitespace and punctuation.
        if (char === " ") pause(70, 220);
        if (".!?".includes(char)) pause(250, 750);
        if (",;:".includes(char)) pause(120, 350);

        const canMistype = /^[a-z]$/i.test(char);
        const makesTypo = canMistype && random() < options.typoRate;

        if (makesTypo) {
            const wrongKey = adjacentTypo(char, random);

            await emitKey(wrongKey);
            pause(100, 400); // Notice the typo.

            await emitKey("Backspace");
            pause(80, 250); // Brief correction pause.
        }

        await emitKey(char);
    }

    await new Promise<void>((resolvePromise, reject) => {
        stream.end((error?: Error | null) => {
            if (error) reject(error);
            else resolvePromise();
        });
    });

    console.log(`Generated ${eventCount} synthetic events.`);
    console.log(`Duration: ${(elapsedMs / 1000).toFixed(2)} seconds`);
    console.log(`Output: ${options.output}`);
}

let isRunning = false;

async function runScheduledJob(): Promise<void> {
    if (isRunning) {
        console.log("[Typing simulator] Previous run still active; skipping.");
        return;
    }

    isRunning = true;

    try {
        await main();
    } catch (error: unknown) {
        console.error("[Typing simulator] Job failed:", error);
    } finally {
        isRunning = false;
    }

}

// Run once immediately when the application starts.
void runScheduledJob();

// Schedule another run every minute.
cron.schedule("*/30 * * * * *", () => { // Every 30 seconds
    void runScheduledJob();
});

console.log("[Typing simulator] Scheduled to run every minute.");

