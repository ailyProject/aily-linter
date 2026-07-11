declare module 'tree-sitter' {
  export interface SyntaxNode {
    type: string;
    text: string;
    childCount: number;
    child(index: number): SyntaxNode | null;
    children: SyntaxNode[];
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
  }

  export interface Tree {
    rootNode: SyntaxNode;
  }

  export interface Language {}

  export default class Parser {
    setLanguage(language: Language): void;
    parse(input: string): Tree;
  }
}

declare module 'tree-sitter-cpp' {
  import { Language } from 'tree-sitter';
  const Cpp: Language;
  export default Cpp;
}
