// Ambiente isolado para testes: banco e projetos em pasta temporária própria.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ese-test-"));
process.env.ESE_DATA_DIR = dir;
// modelos (Kokoro/Whisper) continuam vindo do data/ real do repositório, se existirem
process.env.KOKORO_DIR ??= path.resolve(import.meta.dirname, "..", "..", "data", "modelos", "kokoro");
export const TEST_DIR = dir;
