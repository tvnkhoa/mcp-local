/**
 * ENH-D / ISSUE-014: find_impact_files must surface a `wiringNote` for DI/reflection-wired
 * C# types (MediatR IPipelineBehavior / IEndpointGroup) instead of a bare empty `callers`.
 * These types have no static CALLS edge, so impact analysis would otherwise read as
 * "no dependents" — a dangerous false-empty for exactly the shared-infra changes where
 * blast-radius matters most.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GraphStore } from "../../dist/repositories/graphStore.js";
import { extractGraphData } from "../../dist/services/extractors/treeSitterExtractor.js";

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-wiring-note-"));
  return path.join(tempDir, "test.db");
}

// A MediatR pipeline behaviour (record request types implement IRequest — record-aware
// after ISSUE-013 — so requestCount is non-zero).
const behaviourSource = `
namespace App.Common.Behaviours;

public interface IPipelineBehavior<TRequest, TResponse> {}
public interface IRequest<T> {}
public class Result<T> {}

public class AuthorizationBehaviour<TRequest, TResponse>
  : IPipelineBehavior<TRequest, TResponse>
{
    public async Task<TResponse> Handle() => default;
}
`;

const requestSource = `
namespace App.Features;

public interface IRequest<T> {}
public class Result<T> {}
public class NoteDto {}

public record CreateNoteCommand(string Text) : IRequest<Result<NoteDto>>;
public record GetNoteQuery(int Id) : IRequest<Result<NoteDto>>;
`;

function indexFile(store, repoId, filePath, source) {
  const extracted = extractGraphData({ repoId, filePath, language: "csharp", source });
  store.replaceSymbolsForFile(repoId, filePath, extracted.symbols);
  store.replaceEdgesForFile(repoId, filePath, extracted.edges);
  return extracted;
}

function run() {
  const dbPath = createTempDbPath();
  const store = new GraphStore(dbPath);
  const repoId = "test-wiring";

  store.ensureRepository(repoId, path.dirname(dbPath));

  const behaviourPath = "src/Common/Behaviours/AuthorizationBehaviour.cs";
  indexFile(store, repoId, behaviourPath, behaviourSource);
  indexFile(store, repoId, "src/Features/Notes.cs", requestSource);

  // find_impact_files (view=files) on the behaviour: no static callers, but a wiringNote.
  const impact = store.getImpactFiles(repoId, behaviourPath, 50);
  assert(
    impact.impactedFiles.length === 0,
    `expected no static impacted files for a pipeline behaviour, got ${impact.impactedFiles.length}`
  );
  assert(
    typeof impact.wiringNote === "string" && impact.wiringNote.includes("DI/reflection-wired"),
    `expected a wiringNote explaining DI/reflection wiring, got: ${JSON.stringify(impact.wiringNote)}`
  );
  assert(
    /MediatR pipeline/.test(impact.wiringNote),
    `expected the pipeline note to mention the MediatR pipeline, got: ${impact.wiringNote}`
  );
  // Two record requests were indexed → requestCount should surface in the note.
  assert(
    /\b2 requests\b/.test(impact.wiringNote),
    `expected requestCount=2 in the note, got: ${impact.wiringNote}`
  );

  // surface view returns the same note.
  const surface = store.getImpactSurface(repoId, behaviourPath, 50);
  assert(
    surface.callers.length === 0 && typeof surface.wiringNote === "string",
    `expected surface view to also carry a wiringNote, got callers=${surface.callers.length} note=${JSON.stringify(surface.wiringNote)}`
  );

  // Control: a plain request file (not wired) must NOT get a wiringNote even if impact is empty.
  const plain = store.getImpactFiles(repoId, "src/Features/Notes.cs", 50);
  assert(
    plain.wiringNote === undefined,
    `did not expect a wiringNote for a non-wired file, got: ${JSON.stringify(plain.wiringNote)}`
  );

  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  console.log("[ok] test-wiring-note passed", { wiringNote: impact.wiringNote });
}

try {
  run();
} catch (err) {
  console.error("test-wiring-note: FAILED:", err.message);
  process.exit(1);
}
