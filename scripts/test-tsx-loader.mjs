// Browser-fixture build only. Uses the repository's pinned TypeScript.
import ts from 'typescript';
export default function transpileFixture(source) {
  return ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  }}).outputText;
}
