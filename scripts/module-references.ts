import ts from 'typescript';

export function moduleReferences(source: ts.SourceFile) {
  const imports: { literal: ts.StringLiteral; typeOnly: boolean }[] = [];
  function visit(node: ts.Node) {
    let literal: ts.Node | undefined;
    let typeOnly = false;
    if (ts.isImportDeclaration(node)) {
      literal = node.moduleSpecifier;
      const { importClause: clause } = node;
      const bindings = clause?.namedBindings;
      typeOnly = Boolean(clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length && bindings.elements.every((item) => item.isTypeOnly)));
    } else if (ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
      const { exportClause: clause } = node;
      typeOnly = node.isTypeOnly || Boolean(clause && ts.isNamedExports(clause) &&
        clause.elements.length && clause.elements.every((item) => item.isTypeOnly));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
      typeOnly = true;
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      literal = node.name;
      typeOnly = true;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal = node.arguments[0];
    }
    if (literal && ts.isStringLiteral(literal)) imports.push({ literal, typeOnly });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
