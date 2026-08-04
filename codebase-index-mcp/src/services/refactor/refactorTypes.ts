import type { RefactorRiskFlag } from "../../types/index.js";

export type PreviewCandidateHunk = {
  filePath: string;
  line: number;
  startOffset: number;
  endOffset: number;
  beforeText: string;
  afterText: string;
  ownerType: string | null;
  symbolKind: string | null;
  confidence: number;
  riskFlags: RefactorRiskFlag[];
  fileHashBefore: string;
};

export type CompilerAssistOutcome = {
  hunks: PreviewCandidateHunk[];
  totalDiagnostics: number;
  acceptedDiagnostics: number;
  matchedDiagnostics: number;
  filteredOutHunks: number;
  lineWindow: number;
  codes: string[];
};

export type ObjectInitializerContext = {
  typeName: string;
  openBraceOffset: number;
  endOffset: number;
};

export type InitializerAssignmentContext = {
  initializer: ObjectInitializerContext;
  assignmentStart: number;
  assignmentEnd: number;
  assignmentText: string;
  indent: string;
  expressionText: string;
  trailingComma: boolean;
  hasSiblingAssignments: boolean;
  line: number;
  lineEnding: string;
};

export type RefactorScopeInput = {
  includePaths: string[];
  excludePaths: string[];
  fileGlobs: string[];
};

export type RefactorGuardsInput = {
  language?: string;
  symbolKinds: ("class" | "property" | "field" | "method")[];
  allowOwnerTypes: string[];
  disallowOwnerTypes: string[];
  disallowTypeList: string[];
};

export type RefactorModeInput = "text" | "syntax-aware" | "symbol-aware";

export type RefactorSymbolMigrationInput = {
  fromSymbol: string;
  toSymbol: string;
  requiredOwnerType: string;
  forbiddenOwnerTypes: string[];
  /**
   * Restrict sites to these inferred kinds. Omit (or empty) for any kind — the previous hardcoded
   * ["property", "field"] silently made this tool unusable for method migrations (MCP-ISSUE-043).
   */
  symbolKinds?: ("class" | "property" | "field" | "method")[];
  initializerRewrite?: {
    objectProperty: string;
    objectType: string;
    targetMember?: string;
  };
};

export type RefactorCompilerAssistInput = {
  diagnostics: Array<{
    code: string;
    filePath: string;
    line: number;
    message?: string;
    expectedType?: string;
    actualType?: string;
  }>;
  codes: string[];
  lineWindow: number;
  filePathPrefix?: string;
};
