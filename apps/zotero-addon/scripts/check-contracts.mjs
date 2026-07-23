/**
 * Check that the TypeScript wire interfaces still match the canonical v1 schema.
 *
 * This intentionally compares field names and requiredness, which are the two drift
 * classes that previously survived both TypeScript and Python type checking. Runtime
 * payload examples are validated on the Python side.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(
  scriptDir,
  "../../../packages/contracts/http/v1.schema.json",
);
const contractsPath = path.resolve(scriptDir, "../src/runtime-client/contracts.ts");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const source = ts.createSourceFile(
  contractsPath,
  fs.readFileSync(contractsPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const mappings = new Map([
  ["ConvertOptionsPatch", "ConvertOptionsPatch"],
  ["ConvertRequest", "ConvertRequest"],
  ["AnnotationPayloadItem", "AnnotationPayload"],
  ["AnnotateRequest", "AnnotateRequest"],
  ["HealthResponse", "HealthResponse"],
  ["TemplateSummary", "TemplateSummary"],
  ["TemplateListResponse", "TemplateListResponse"],
  ["WorkflowListResponse", "WorkflowListResponse"],
  ["WorkflowTemplateDocument", "WorkflowTemplateDocument"],
  ["TemplateDetail", "TemplateDetail"],
  ["ConvertAccepted", "JobAccepted"],
  ["JobState", "JobStatusResponse"],
  ["AnnotateResponse", "AnnotateResponse"],
]);

const interfaces = new Map();
for (const statement of source.statements) {
  if (!ts.isInterfaceDeclaration(statement)) { continue; }
  const fields = new Map();
  for (const member of statement.members) {
    if (!ts.isPropertySignature(member) || !member.name) { continue; }
    const name = member.name.getText(source).replace(/^["']|["']$/g, "");
    fields.set(name, !member.questionToken);
  }
  interfaces.set(statement.name.text, fields);
}

const failures = [];
for (const [interfaceName, definitionName] of mappings) {
  const actual = interfaces.get(interfaceName);
  const definition = schema.$defs?.[definitionName];
  if (!actual) {
    failures.push(`missing TypeScript interface ${interfaceName}`);
    continue;
  }
  if (!definition) {
    failures.push(`missing schema definition ${definitionName}`);
    continue;
  }
  const expectedNames = new Set(Object.keys(definition.properties || {}));
  const actualNames = new Set(actual.keys());
  const missing = [...expectedNames].filter((name) => !actualNames.has(name));
  const extra = [...actualNames].filter((name) => !expectedNames.has(name));
  if (missing.length || extra.length) {
    failures.push(
      `${interfaceName}: fields differ; missing=[${missing}], extra=[${extra}]`,
    );
  }
  const required = new Set(definition.required || []);
  for (const name of expectedNames) {
    if (!actual.has(name)) { continue; }
    if (actual.get(name) !== required.has(name)) {
      failures.push(
        `${interfaceName}.${name}: required=${actual.get(name)} in TypeScript, ` +
        `${required.has(name)} in schema`,
      );
    }
  }
}

let apiVersion;
let requiredCapabilities;
for (const statement of source.statements) {
  if (!ts.isVariableStatement(statement)) { continue; }
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name.getText(source);
    if (name === "API_VERSION" && ts.isStringLiteral(declaration.initializer)) {
      apiVersion = declaration.initializer.text;
    }
    if (name === "REQUIRED_CAPABILITIES" && declaration.initializer) {
      const expression = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (ts.isArrayLiteralExpression(expression)) {
        requiredCapabilities = expression.elements.map((item) => item.text);
      }
    }
  }
}

if (apiVersion !== schema["x-api-version"]) {
  failures.push(
    `API_VERSION=${apiVersion}, schema=${schema["x-api-version"]}`,
  );
}
if (JSON.stringify(requiredCapabilities) !==
    JSON.stringify(schema["x-required-capabilities"])) {
  failures.push("REQUIRED_CAPABILITIES differs from the canonical schema");
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`[contract] ${failure}`);
  }
  process.exit(1);
}

console.log(`[contract] ${mappings.size} TypeScript interfaces match HTTP v1 schema`);
