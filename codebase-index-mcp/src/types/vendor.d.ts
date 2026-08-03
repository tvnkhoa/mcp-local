// Ambient module declarations for tree-sitter grammar packages that ship without type definitions.
declare module "tree-sitter-c-sharp" {
  import type Parser from "tree-sitter";
  const language: Parser.Language;
  export = language;
}
