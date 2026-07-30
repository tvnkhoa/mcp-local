import type Database from "better-sqlite3";

// ── Find provider symbol by name across repos (ISSUE-006) ─────────────
//
// Given a type name and the consuming repo's known nuget contract IDs,
// look up a matching symbol in any provider repo whose module symbol
// has a matching nuget: signature. Returns the best candidate.

export function findProviderSymbolByName(
  db: Database.Database,
  consumerRepoId: string,
  typeName: string
): { symbolId: string; repoId: string; filePath: string } | null {
  // Step 1: find nuget: contract IDs that the consumer repo depends on
  const contractRows = db
    .prepare(
      `
      select distinct e.to_id as contractId
      from edges e
      where e.repo_id = ?
        and e.type = 'DEPENDS_ON'
        and e.to_id like 'nuget:%'
      `
    )
    .all(consumerRepoId) as { contractId: string }[];

  if (contractRows.length === 0) return null;

  const contractIds = contractRows.map((r) => r.contractId);
  const ph = contractIds.map(() => "?").join(", ");

  // Step 2: find provider repos that export one of those contracts
  const providerRepos = db
    .prepare(
      `
      select distinct s.repo_id as repoId
      from symbols s
      where s.kind = 'module'
        and s.signature in (${ph})
        and s.repo_id != ?
      `
    )
    .all(...contractIds, consumerRepoId) as { repoId: string }[];

  if (providerRepos.length === 0) return null;

  const providerRepoIds = providerRepos.map((r) => r.repoId);
  const ph2 = providerRepoIds.map(() => "?").join(", ");

  // Step 3: find a symbol with matching name in those provider repos
  const match = db
    .prepare(
      `
      select s.symbol_id as symbolId, s.repo_id as repoId, s.file_path as filePath
      from symbols s
      where s.repo_id in (${ph2})
        and s.name = ?
        and s.kind in ('class', 'interface', 'struct', 'type')
      -- repo_id alone is not a total order: a provider repo commonly declares the same type name in
      -- several files (partial classes, per-namespace duplicates), and the winner was then arbitrary.
      order by s.repo_id, s.symbol_id
      limit 1
      `
    )
    .get(...providerRepoIds, typeName) as { symbolId: string; repoId: string; filePath: string } | undefined;

  return match ?? null;
}



export function upsertCrossRepoDepImpl(
  db: Database.Database,
  fromRepoId: string,
  fromSymbolId: string,
  toRepoId: string,
  toSymbolId: string,
  type: string
): void {
  db.prepare(
    `
    insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
    values (?, ?, ?, ?, ?)
    on conflict do nothing
    `
  ).run(fromRepoId, fromSymbolId, toRepoId, toSymbolId, type);
}

// ── Get cross-repo deps ────────────────────────────────────────────────

export function getCrossRepoDepsImpl(
  db: Database.Database,
  fromRepoId: string,
  fromSymbolId: string,
  limit: number
): {
  toRepoId: string;
  toSymbolId: string;
  type: string;
}[] {
  return db
    .prepare(
      `
      select to_repo_id as toRepoId, to_symbol_id as toSymbolId, type
      from cross_repo_deps
      where from_repo_id = ? and from_symbol_id = ?
      limit ?
      `
    )
    .all(fromRepoId, fromSymbolId, limit) as { toRepoId: string; toSymbolId: string; type: string }[];
}

// ── Get cross-repo impact ──────────────────────────────────────────────

export function getCrossRepoImpactImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  direction: "outbound" | "inbound",
  limit: number
): {
  fromRepoId: string;
  fromSymbolId: string;
  toRepoId: string;
  toSymbolId: string;
  type: string;
  relatedName: string | null;
  relatedKind: string | null;
  relatedFilePath: string | null;
  relatedSignature: string | null;
}[] {
  if (direction === "outbound") {
    return db
      .prepare(
        `
        select
          c.from_repo_id as fromRepoId,
          c.from_symbol_id as fromSymbolId,
          c.to_repo_id as toRepoId,
          c.to_symbol_id as toSymbolId,
          c.type as type,
          s.name as relatedName,
          s.kind as relatedKind,
          s.file_path as relatedFilePath,
          s.signature as relatedSignature
        from cross_repo_deps c
        left join symbols s
          on s.repo_id = c.to_repo_id and s.symbol_id = c.to_symbol_id
        where c.from_repo_id = ? and c.from_symbol_id = ?
        order by c.to_repo_id, c.to_symbol_id
        limit ?
        `
      )
      .all(repoId, symbolId, limit) as {
      fromRepoId: string;
      fromSymbolId: string;
      toRepoId: string;
      toSymbolId: string;
      type: string;
      relatedName: string | null;
      relatedKind: string | null;
      relatedFilePath: string | null;
      relatedSignature: string | null;
    }[];
  }

  return db
    .prepare(
      `
      select
        c.from_repo_id as fromRepoId,
        c.from_symbol_id as fromSymbolId,
        c.to_repo_id as toRepoId,
        c.to_symbol_id as toSymbolId,
        c.type as type,
        s.name as relatedName,
        s.kind as relatedKind,
        s.file_path as relatedFilePath,
        s.signature as relatedSignature
      from cross_repo_deps c
      left join symbols s
        on s.repo_id = c.from_repo_id and s.symbol_id = c.from_symbol_id
      where c.to_repo_id = ? and c.to_symbol_id = ?
      order by c.from_repo_id, c.from_symbol_id
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as {
    fromRepoId: string;
    fromSymbolId: string;
    toRepoId: string;
    toSymbolId: string;
    type: string;
    relatedName: string | null;
    relatedKind: string | null;
    relatedFilePath: string | null;
    relatedSignature: string | null;
  }[];
}

// ── Find package consumers ─────────────────────────────────────────────

export function findPackageConsumersImpl(
  db: Database.Database,
  packageContractId: string,
  repoId: string | null,
  limit: number
): {
  consumerRepoId: string;
  consumerSymbolId: string;
  consumerName: string | null;
  consumerKind: string | null;
  consumerFilePath: string | null;
  packageContractId: string;
  dependencyReason: string | null;
  providerRepoId: string | null;
  providerSymbolId: string | null;
}[] {
  if (repoId) {
    return db
      .prepare(
        `
        select
          e.repo_id as consumerRepoId,
          e.from_id as consumerSymbolId,
          s.name as consumerName,
          s.kind as consumerKind,
          s.file_path as consumerFilePath,
          e.to_id as packageContractId,
          e.reason as dependencyReason,
          c.to_repo_id as providerRepoId,
          c.to_symbol_id as providerSymbolId
        from edges e
        left join symbols s
          on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        left join cross_repo_deps c
          on c.from_repo_id = e.repo_id
          and c.from_symbol_id = e.from_id
          and c.type = e.type
          and exists (
            select 1
            from symbols ps
            where ps.repo_id = c.to_repo_id
              and ps.symbol_id = c.to_symbol_id
              and ps.signature = e.to_id
          )
        where e.type = 'DEPENDS_ON'
          and e.to_id = ?
          and e.repo_id = ?
        order by e.repo_id, s.file_path, s.name
        limit ?
        `
      )
      .all(packageContractId, repoId, limit) as {
      consumerRepoId: string;
      consumerSymbolId: string;
      consumerName: string | null;
      consumerKind: string | null;
      consumerFilePath: string | null;
      packageContractId: string;
      dependencyReason: string | null;
      providerRepoId: string | null;
      providerSymbolId: string | null;
    }[];
  }

  return db
    .prepare(
      `
      select
        e.repo_id as consumerRepoId,
        e.from_id as consumerSymbolId,
        s.name as consumerName,
        s.kind as consumerKind,
        s.file_path as consumerFilePath,
        e.to_id as packageContractId,
        e.reason as dependencyReason,
        c.to_repo_id as providerRepoId,
        c.to_symbol_id as providerSymbolId
      from edges e
      left join symbols s
        on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      left join cross_repo_deps c
        on c.from_repo_id = e.repo_id
        and c.from_symbol_id = e.from_id
        and c.type = e.type
        and exists (
          select 1
          from symbols ps
          where ps.repo_id = c.to_repo_id
            and ps.symbol_id = c.to_symbol_id
            and ps.signature = e.to_id
        )
      where e.type = 'DEPENDS_ON'
        and e.to_id = ?
      order by e.repo_id, s.file_path, s.name
      limit ?
      `
    )
    .all(packageContractId, limit) as {
    consumerRepoId: string;
    consumerSymbolId: string;
    consumerName: string | null;
    consumerKind: string | null;
    consumerFilePath: string | null;
    packageContractId: string;
    dependencyReason: string | null;
    providerRepoId: string | null;
    providerSymbolId: string | null;
  }[];
}

// ── Find similar package contract IDs (did-you-mean support) ────────────
//
// When an exact packageContractId returns 0 consumers, look up all indexed
// nuget: contract IDs that share a common prefix with the queried name.
// Returns up to `limit` distinct contract IDs (excluding the exact match).

export function findSimilarPackageContractIdsImpl(
  db: Database.Database,
  packageContractId: string,
  repoId: string | null,
  limit: number
): string[] {
  // LIKE pattern: nuget:fluentvalidation% — matches all sub-packages and variants
  const basePrefix = packageContractId.replace(/:$/, "") + "%";

  const query = repoId
    ? `select distinct e.to_id as contractId
       from edges e
       where e.repo_id = ?
         and e.type = 'DEPENDS_ON'
         and e.to_id like ?
         and e.to_id != ?
       order by e.to_id
       limit ?`
    : `select distinct e.to_id as contractId
       from edges e
       where e.type = 'DEPENDS_ON'
         and e.to_id like ?
         and e.to_id != ?
       order by e.to_id
       limit ?`;

  const params = repoId
    ? [repoId, basePrefix, packageContractId, limit]
    : [basePrefix, packageContractId, limit];

  return (db.prepare(query).all(...params) as { contractId: string }[]).map((r) => r.contractId);
}

// ── Get package bridge stats ───────────────────────────────────────────

export function getPackageBridgeStatsImpl(
  db: Database.Database,
  repoId: string
): {
  packageAttempts: number;
  packageResolved: number;
  packageNoCandidate: number;
} {
  const attemptsRow = db
    .prepare(
      `
      select count(distinct e.from_id || '|' || e.to_id) as packageAttempts
      from edges e
      where e.repo_id = ?
        and e.type = 'DEPENDS_ON'
        and e.to_id like 'nuget:%'
      `
    )
    .get(repoId) as { packageAttempts: number } | undefined;

  const resolvedRow = db
    .prepare(
      `
      select count(distinct e.from_id || '|' || e.to_id) as packageResolved
      from edges e
      where e.repo_id = ?
        and e.type = 'DEPENDS_ON'
        and e.to_id like 'nuget:%'
        and exists (
          select 1
          from cross_repo_deps c
          inner join symbols ps
            on ps.repo_id = c.to_repo_id
            and ps.symbol_id = c.to_symbol_id
          where c.from_repo_id = e.repo_id
            and c.from_symbol_id = e.from_id
            and c.type = e.type
            and ps.signature = e.to_id
        )
      `
    )
    .get(repoId) as { packageResolved: number } | undefined;

  const packageAttempts = attemptsRow?.packageAttempts ?? 0;
  const packageResolved = resolvedRow?.packageResolved ?? 0;
  return {
    packageAttempts,
    packageResolved,
    packageNoCandidate: Math.max(0, packageAttempts - packageResolved)
  };
}
