/**
 * The C# suppression policy for `dead_code_scan`.
 *
 * A symbol reached only by the framework - a minimal-API endpoint, a FluentValidation validator,
 * an attribute, a DI registration extension - has no inbound CALLS edge and would otherwise be
 * reported as dead. These heuristics recognise those shapes so the scan stays useful on a .NET
 * repo. They are guesses, which is why a match *suppresses* a candidate under a named reason
 * rather than dropping it silently: `scanPolicy.mode` is "skip_low_confidence".
 *
 * S-41 extracted three closures from `getDeadCodeCandidates` into the functions below. The
 * `fileContexts` map all three captured is now passed explicitly, and the six name patterns
 * moved to module scope - safe because none carries the `g` or `y` flag, so there is no
 * `lastIndex` state to share between calls.
 *
 * The order of the checks in `getCSharpSuppressionReason` is load-bearing: first match wins, and
 * it decides which reason the suppression is attributed to. That one ordered chain is why this
 * file is not split further.
 */

/**
 * C# kinds that the dead-code heuristics treat as a "class". Records (and record structs) used
 * to be indexed as `class`, so the suppression heuristics below keyed on `kind === "class"`
 * implicitly covered them; after ISSUE-015 relabeled records they must be listed explicitly or
 * record validators/attributes/services/endpoints regress to false dead-code positives.
 */
const CSHARP_CLASS_LIKE_KINDS = new Set<string>(["class", "record", "record struct"]);

const utilityNamePattern = /^(to|from|get|set|map|parse|format|build|create|validate|convert|helper|util)/i;
const entryNamePattern = /^(main|init|initialize|bootstrap|start|run|handle|on|process|execute|dispatch|trigger)/i;
const csharpUtilityClassNamePattern = /(extractor|helper|extensions|codec|composer|factory|builder|parser|formatter|normalizer|provider)$/i;
const csharpConstantContainerNamePattern = /(constants?|errorcodes|statuscodes|codes|types|keys|outcomes|reasons|roles|policies|claimtypes|headernames|items)$/i;
const csharpUtilityMethodNamePattern = /^(create|build|compose|format|normalize|parse|tryparse|failure|success|from|to)/i;
const csharpValidatorHelperMethodNamePattern = /^(be|have|is|can|should|must|tryparse|normalize|format|supports?)/i;

/** One row of the dead-code scan, as selected by `getDeadCodeCandidates`. */
export interface DeadCodeRow {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  signature: string | null;
  language: string | null;
  incomingCalls: number;
  incomingTypeRefs: number;
  incomingImports: number;
  incomingPublishes: number;
  outgoingCalls: number;
  fileIncomingUsages: number;
}

/**
 * What the other class-like symbols in the same file say about a candidate.
 *
 * Needed because C# spreads the evidence across declarations: a private helper method is only
 * recognisable as a validator helper if some class in that file is a validator.
 */
export interface DeadCodeFileContext {
  hasValidatorClass: boolean;
  hasInterfaceImplementationClass: boolean;
  hasAttributeClass: boolean;
  hasStaticUtilityClass: boolean;
  hasServiceLikeClass: boolean;
  isConstantContainerFile: boolean;
}

/** A fresh, all-false context. Must stay a factory: `buildFileContexts` mutates what it gets. */
function emptyFileContext(): DeadCodeFileContext {
  return {
    hasValidatorClass: false,
    hasInterfaceImplementationClass: false,
    hasAttributeClass: false,
    hasStaticUtilityClass: false,
    hasServiceLikeClass: false,
    isConstantContainerFile: false
  };
}

/** Pre-pass over every scanned row, collecting the per-file evidence the predicates below use. */
export function buildFileContexts(rows: readonly DeadCodeRow[]): Map<string, DeadCodeFileContext> {
  const fileContexts = new Map<string, DeadCodeFileContext>();

  for (const row of rows) {
    if ((row.language ?? "").toLowerCase() !== "csharp" || !CSHARP_CLASS_LIKE_KINDS.has(row.kind)) {
      continue;
    }

    const signatureLower = (row.signature ?? "").toLowerCase();
    const fileContext = fileContexts.get(row.filePath) ?? emptyFileContext();
    const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();

    if (
      /validator$/i.test(row.name) ||
      signatureLower.includes("abstractvalidator<") ||
      signatureLower.includes("ivalidator<")
    ) {
      fileContext.hasValidatorClass = true;
    }

    if (
      /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "") &&
      /\s:\s*i[a-z]/.test(signatureLower) &&
      !/\s:\s*attribute\b/.test(signatureLower)
    ) {
      fileContext.hasInterfaceImplementationClass = true;
    }

    if (/attribute$/i.test(row.name) || /\s:\s*attribute\b/.test(signatureLower)) {
      fileContext.hasAttributeClass = true;
    }

    if (
      /(public|internal|file) static class /i.test(row.signature ?? "") &&
      (
        csharpUtilityClassNamePattern.test(row.name) ||
        csharpConstantContainerNamePattern.test(row.name)
      )
    ) {
      fileContext.hasStaticUtilityClass = true;
    }

    if (
      /(service|resolver|worker)$/i.test(row.name) ||
      /:\s*backgroundservice\b/.test(signatureLower)
    ) {
      fileContext.hasServiceLikeClass = true;
    }

    if (normalizedPath.includes("/constants/")) {
      fileContext.isConstantContainerFile = true;
    }

    fileContexts.set(row.filePath, fileContext);
  }

  return fileContexts;
}

/**
 * A scored guess that a symbol is an entry point. C# only, on purpose: the same scoring applied
 * to TypeScript produced cross-language false negatives.
 */
export function isLikelyEntryPoint(
  row: DeadCodeRow,
  fileContexts: Map<string, DeadCodeFileContext>
): boolean {
  // Keep the heuristic narrow to reduce cross-language false negatives.
  if ((row.language ?? "").toLowerCase() !== "csharp") {
    return false;
  }

  if (row.outgoingCalls < 2) {
    return false;
  }

  const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
  const signatureLower = (row.signature ?? "").toLowerCase();
  const name = row.name;
  const fileContext = fileContexts.get(row.filePath) ?? emptyFileContext();

  const hasEntryName = entryNamePattern.test(name);
  const hasUtilityName = utilityNamePattern.test(name);
  const inEntryPath =
    normalizedPath.endsWith("/program.cs") ||
    normalizedPath.endsWith("/startup.cs") ||
    normalizedPath.includes("/controllers/") ||
    normalizedPath.includes("/handlers/") ||
    normalizedPath.includes("/hubs/") ||
    normalizedPath.includes("/backgroundservices/") ||
    normalizedPath.includes("/hostedservices/") ||
    normalizedPath.includes("/api/");
  const isPublicLike = signatureLower.startsWith("public ") || signatureLower.includes(" public ");

  // Lightweight score inspired by GitNexus entry-point scoring:
  // require outgoing calls, then combine path/name/visibility hints.
  let score = 0;
  if (isPublicLike) score += 1;
  if (hasEntryName) score += 1;
  if (inEntryPath) score += 1;
  if (row.outgoingCalls >= 3) score += 1;
  if (hasUtilityName) score -= 1;

  return score >= 2 && (hasEntryName || inEntryPath);
}

/**
 * The named suppression reason for a C# row, or `null` to let the scan judge it on edges alone.
 *
 * First match wins - see the note on ordering at the top of this file.
 */
export function getCSharpSuppressionReason(
  row: DeadCodeRow,
  fileContexts: Map<string, DeadCodeFileContext>
): string | null {
  if ((row.language ?? "").toLowerCase() !== "csharp") {
    return null;
  }

  const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
  const signatureLower = (row.signature ?? "").toLowerCase();
  const name = row.name;
  const fileContext = fileContexts.get(row.filePath) ?? emptyFileContext();

  const isExtensionMethod =
    row.kind === "method" && /\(\s*this\s+/i.test(row.signature ?? "");
  if (isExtensionMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isMigrationOrDesignerArtifact =
    normalizedPath.includes("/migrations/") ||
    normalizedPath.endsWith(".designer.cs");
  if (isMigrationOrDesignerArtifact) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isValidatorClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) && (
      normalizedPath.includes("/validators/") ||
      /validator$/i.test(name) ||
      signatureLower.includes("abstractvalidator<") ||
      signatureLower.includes("ivalidator<")
    );
  if (isValidatorClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isValidatorHelperMethod =
    row.kind === "method" &&
    fileContext.hasValidatorClass &&
    signatureLower.startsWith("private ") &&
    csharpValidatorHelperMethodNamePattern.test(name);
  if (isValidatorHelperMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const fileName = normalizedPath.split("/").pop() ?? "";
  const isInterfaceContractMethod =
    row.kind === "method" && (
      normalizedPath.includes("/interfaces/") ||
      normalizedPath.includes("/contracts/") ||
      normalizedPath.includes("/abstractions/") ||
      /^i[a-z].*\.cs$/.test(fileName)
    );
  if (isInterfaceContractMethod) {
    return "heuristic_contract_declaration";
  }

  const isAbstractContractMethod =
    row.kind === "method" && (
      signatureLower.startsWith("public abstract ") ||
      signatureLower.startsWith("protected abstract ") ||
      /abstractions?\.cs$/.test(fileName)
    );
  if (isAbstractContractMethod) {
    return "heuristic_contract_declaration";
  }

  const isInterfaceImplementationClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    fileContext.hasInterfaceImplementationClass &&
    /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "");
  if (isInterfaceImplementationClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isInterfaceImplementationMethod =
    row.kind === "method" &&
    fileContext.hasInterfaceImplementationClass &&
    signatureLower.startsWith("public ") &&
    !signatureLower.includes(" static ");
  if (isInterfaceImplementationMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isReflectionTargetInInterfaceImplementationFile =
    row.kind === "method" &&
    fileContext.hasInterfaceImplementationClass &&
    signatureLower.startsWith("private ") &&
    /(internal|handle|resolve|publish|send|map|serialize|execute|observe)/i.test(name);
  if (isReflectionTargetInInterfaceImplementationFile) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isAttributeClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    fileContext.hasAttributeClass &&
    (/attribute$/i.test(name) || /\s:\s*attribute\b/.test(signatureLower));
  if (isAttributeClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isServiceLikeClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    fileContext.hasServiceLikeClass &&
    /(service|resolver|worker)$/i.test(name);
  if (isServiceLikeClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isFrameworkRegisteredClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    (
      /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)$/i.test(name) ||
      normalizedPath.includes("/interceptors/")
    );
  if (isFrameworkRegisteredClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isServiceLikeMethod =
    row.kind === "method" &&
    fileContext.hasServiceLikeClass &&
    (
      signatureLower.startsWith("public ") ||
      signatureLower.startsWith("protected override ") ||
      signatureLower.startsWith("private ")
    ) &&
    /(apply|get|resolve|execute|purge|map|serialize|handle|send|publish)/i.test(name);
  if (isServiceLikeMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isFrameworkRegisteredMethod =
    row.kind === "method" &&
    (
      /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)/i.test(fileName) ||
      normalizedPath.includes("/interceptors/")
    );
  if (isFrameworkRegisteredMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  // Minimal API endpoints, middleware, and OpenAPI transformers are
  // registered via convention/framework and never have direct inbound call edges.
  const isMinimalApiEndpointMethod =
    row.kind === "method" &&
    (
      normalizedPath.includes("/endpoints/") ||
      normalizedPath.includes("/middleware/")
    );
  if (isMinimalApiEndpointMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isMinimalApiEndpointClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    (
      normalizedPath.includes("/endpoints/") ||
      normalizedPath.includes("/middleware/") ||
      /(middleware|transformer|operationtransformer)$/i.test(name)
    );
  if (isMinimalApiEndpointClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isRegistrationExtensionsClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    (/extensions$/i.test(name) || name === "DependencyInjection") &&
    signatureLower.startsWith("public static class ");
  if (isRegistrationExtensionsClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isInternalStaticHelperContainerClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    signatureLower.includes("static class") &&
    (
      signatureLower.startsWith("public static class ") ||
      signatureLower.startsWith("internal static class ") ||
      signatureLower.startsWith("file static class ")
    ) &&
    (
      normalizedPath.includes("/extensions/") ||
      normalizedPath.includes("/helpers/") ||
      /(extractor|helper|extensions|codec|composer)$/i.test(name)
    );
  if (isInternalStaticHelperContainerClass) {
    return "heuristic_helper_container";
  }

  const isConstantContainerClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    (
      csharpConstantContainerNamePattern.test(name) ||
      fileContext.isConstantContainerFile
    ) &&
    signatureLower.includes("class ");

  if (isConstantContainerClass) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isConstantContainerMethod =
    row.kind === "method" &&
    fileContext.isConstantContainerFile &&
    signatureLower.includes("static ");
  if (isConstantContainerMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isPublicStaticUtilityContainerClass =
    CSHARP_CLASS_LIKE_KINDS.has(row.kind) &&
    fileContext.hasStaticUtilityClass &&
    signatureLower.includes("static class") &&
    csharpUtilityClassNamePattern.test(name);
  if (isPublicStaticUtilityContainerClass) {
    return "heuristic_helper_container";
  }

  const isPublicStaticUtilityMethod =
    row.kind === "method" &&
    signatureLower.startsWith("public static ") &&
    csharpUtilityMethodNamePattern.test(name) &&
    (
      fileContext.hasStaticUtilityClass ||
      normalizedPath.includes("/common/") ||
      normalizedPath.includes("/models/")
    );
  if (isPublicStaticUtilityMethod) {
    return "heuristic_runtime_or_convention_usage";
  }

  const isPrivateStaticFactoryHelperMethod =
    row.kind === "method" &&
    row.outgoingCalls > 0 &&
    signatureLower.startsWith("private static ") &&
    /^(create|build|compose|resolve|map|convert|deserialize)/i.test(name) &&
    (
      /<t>/i.test(row.signature ?? "") ||
      signatureLower.includes("result<") ||
      signatureLower.includes("task<") ||
      /failure|factory|builder/i.test(name)
    );

  return isPrivateStaticFactoryHelperMethod ? "heuristic_runtime_or_convention_usage" : null;
}
