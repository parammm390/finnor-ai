import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const finnorOsRoot = resolve(scriptDirectory, "../..");
export const repositoryRoot = resolve(finnorOsRoot, "..");
const pluginRoot = join(finnorOsRoot, "packages/domain-plugins");
export const generatedReleaseDirectory = join(repositoryRoot, "docs/release/generated");

export interface DiscoveredAction {
  plugin: string;
  actionType: string;
  sourcePath: string;
  sourceLine: number;
  schemaSourcePath: string | null;
  schemaSourceLine: number | null;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function declaredConstants(source: ts.SourceFile): Map<string, ts.Expression> {
  const constants = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

function actionTypesFrom(expression: ts.Expression, constants: Map<string, ts.Expression>): string[] {
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => {
      if (ts.isStringLiteral(element)) return [element.text];
      if (ts.isIdentifier(element)) {
        const initializer = constants.get(element.text);
        return initializer ? actionTypesFrom(initializer, constants) : [];
      }
      return [];
    });
  }
  if (ts.isStringLiteral(expression)) return [expression.text];
  if (
    ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.expression.getText() === "Object"
    && expression.expression.name.text === "keys"
    && expression.arguments.length === 1
    && ts.isIdentifier(expression.arguments[0]!)
  ) {
    const schemas = constants.get(expression.arguments[0]!.text);
    if (!schemas || !ts.isObjectLiteralExpression(schemas)) return [];
    return schemas.properties
      .map(propertyName)
      .filter((name): name is string => Boolean(name));
  }
  return [];
}

function actionTypesProperty(source: ts.SourceFile): ts.PropertyAssignment | null {
  let result: ts.PropertyAssignment | null = null;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isPropertyAssignment(node) && propertyName(node) === "actionTypes") result = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function payloadSchemaProperty(source: ts.SourceFile): ts.PropertyAssignment | null {
  let result: ts.PropertyAssignment | null = null;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isPropertyAssignment(node) && propertyName(node) === "payloadSchemas") result = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function lineFor(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

async function pluginIndexFiles(): Promise<string[]> {
  const activePluginDirectories = [
    "clarification",
    "computer-task",
    "private-equity",
    "universal-actions",
    "web-research",
  ] as const;
  const entries = await readdir(pluginRoot, { withFileTypes: true });
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  for (const plugin of activePluginDirectories) {
    if (!directories.has(plugin)) throw new Error(`Active plugin directory is missing: ${plugin}`);
  }
  return activePluginDirectories.map((entry) => join(pluginRoot, entry, "index.ts")).sort();
}

export async function discoverActionRegistry(): Promise<DiscoveredAction[]> {
  const actions: DiscoveredAction[] = [];
  for (const filePath of await pluginIndexFiles()) {
    const text = await readFile(filePath, "utf8");
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = declaredConstants(source);
    const actionProperty = actionTypesProperty(source);
    if (!actionProperty) throw new Error(`No actionTypes declaration found in ${relative(repositoryRoot, filePath)}`);
    const actionTypes = actionTypesFrom(actionProperty.initializer, constants);
    if (actionTypes.length === 0) throw new Error(`Could not statically derive actionTypes in ${relative(repositoryRoot, filePath)} from ${actionProperty.initializer.getText(source)}`);
    const schemaProperty = payloadSchemaProperty(source);
    const plugin = relative(pluginRoot, filePath).split("/")[0]!;
    for (const actionType of actionTypes) {
      actions.push({
        plugin,
        actionType,
        sourcePath: relative(repositoryRoot, filePath),
        sourceLine: lineFor(source, actionProperty),
        schemaSourcePath: schemaProperty ? relative(repositoryRoot, filePath) : null,
        schemaSourceLine: schemaProperty ? lineFor(source, schemaProperty) : null,
      });
    }
  }
  const duplicate = actions.find((action, index) => actions.findIndex((candidate) => candidate.actionType === action.actionType) !== index);
  if (duplicate) throw new Error(`Duplicate discovered action type: ${duplicate.actionType}`);
  return actions.sort((left, right) => left.actionType.localeCompare(right.actionType));
}

export async function writeDiscoveredActionManifest(actions?: DiscoveredAction[]): Promise<string> {
  const manifestActions = actions ?? await discoverActionRegistry();
  await mkdir(generatedReleaseDirectory, { recursive: true });
  const target = join(generatedReleaseDirectory, "action-manifest.json");
  await writeFile(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), actionCount: manifestActions.length, actions: manifestActions }, null, 2)}\n`);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const actions = await discoverActionRegistry();
    const target = await writeDiscoveredActionManifest(actions);
    console.log(`Discovered ${actions.length} action types in ${relative(repositoryRoot, target)}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
