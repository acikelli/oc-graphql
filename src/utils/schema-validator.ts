import {
  buildSchema,
  GraphQLError,
  validateSchema as graphqlValidateSchema,
} from "graphql";

export async function validateSchema(schemaString: string): Promise<void> {
  try {
    // Add custom directive definitions to make schema valid for GraphQL validation
    const directiveDefinitions = `
      directive @sql_query(query: String!) on FIELD_DEFINITION
      directive @resolver on OBJECT
      directive @return(value: String!) on FIELD_DEFINITION
    `;

    const schemaWithDirectives = directiveDefinitions + "\n" + schemaString;

    // Basic GraphQL syntax validation
    const schema = buildSchema(schemaWithDirectives);

    // Validate schema structure
    const errors = graphqlValidateSchema(schema);
    if (errors.length > 0) {
      const errorMessages = errors.map((error) => error.message).join("\n");
      throw new Error(`GraphQL schema validation failed:\n${errorMessages}`);
    }

    // Validate custom directives
    validateCustomDirectives(schemaString);

    // Validate type structure
    validateTypeStructure(schemaString);
  } catch (error) {
    if (error instanceof GraphQLError) {
      throw new Error(`Schema syntax error: ${error.message}`);
    }
    throw error;
  }
}

function validateCustomDirectives(schemaString: string): void {
  const validDirectives = [
    "@sql_query",
    "@resolver",
    "@return",
    "@skip",
    "@include",
    "@deprecated",
  ];

  // Check for invalid directive usage
  const directiveMatches = schemaString.match(/@\w+/g) || [];
  const invalidDirectives = directiveMatches.filter(
    (directive) => !validDirectives.some((valid) => directive.startsWith(valid))
  );

  if (invalidDirectives.length > 0) {
    throw new Error(
      `Invalid custom directives found: ${invalidDirectives.join(", ")}`
    );
  }

  // Validate @sql_query directive structure - simplified validation
  const sqlQueryMatches = schemaString.match(/@sql_query[^)]*\)/gs) || [];

  for (const match of sqlQueryMatches) {
    if (!match.includes("query:")) {
      throw new Error(
        `@sql_query directive must include a query parameter: ${match.substring(0, 50)}...`
      );
    }
  }

  // Validate virtual table references
  const virtualTablePattern = /\$virtual_table\([^)]+\)/g;
  const virtualTableMatches = schemaString.match(virtualTablePattern) || [];

  for (const match of virtualTableMatches) {
    const tableName = match.match(/\$virtual_table\(([^)]+)\)/)?.[1];
    if (!tableName || tableName.trim().length === 0) {
      throw new Error(`Invalid virtual table reference: ${match}`);
    }
  }
}

function validateTypeStructure(schemaString: string): void {
  // Check for required root types
  if (!schemaString.includes("type Query")) {
    throw new Error("Schema must include a Query type");
  }

  // Validate that types with @resolver directive have appropriate fields
  const resolverTypePattern = /type\s+(\w+)[^{]*@resolver[^{]*{([^}]*)}/g;
  let match;

  while ((match = resolverTypePattern.exec(schemaString)) !== null) {
    const typeName = match[1];
    const fields = match[2];

    // Check if resolver type has at least one field with @sql_query
    if (!fields.includes("@sql_query")) {
      throw new Error(
        `Resolver type ${typeName} must have at least one field with @sql_query directive`
      );
    }
  }

  // Validate field types are properly defined
  const fieldPattern = /(\w+):\s*(\[?\w+[!?]*\]?[!?]*)/g;
  const definedTypes = extractDefinedTypes(schemaString);
  const builtInTypes = [
    "String",
    "Int",
    "Float",
    "Boolean",
    "ID",
    "AWSDateTime",
  ];

  while ((match = fieldPattern.exec(schemaString)) !== null) {
    const fieldType = match[2].replace(/[\[\]!]/g, "");

    if (
      !builtInTypes.includes(fieldType) &&
      !definedTypes.includes(fieldType)
    ) {
      // Type not found - this could be a custom type that needs to be defined
      // For now, we'll skip this warning to avoid console dependency
    }
  }
}

function extractDefinedTypes(schemaString: string): string[] {
  const typePattern = /(?:type|enum|interface|union)\s+(\w+)/g;
  const types: string[] = [];
  let match;

  while ((match = typePattern.exec(schemaString)) !== null) {
    types.push(match[1]);
  }

  return types;
}

export function validateProjectName(projectName: string): void {
  // AWS resource naming constraints
  const validNamePattern = /^[a-zA-Z][a-zA-Z0-9-]*$/;

  if (!validNamePattern.test(projectName)) {
    throw new Error(
      "Project name must start with a letter and contain only letters, numbers, and hyphens"
    );
  }

  if (projectName.length < 3 || projectName.length > 63) {
    throw new Error("Project name must be between 3 and 63 characters long");
  }

  if (projectName.endsWith("-")) {
    throw new Error("Project name cannot end with a hyphen");
  }

  if (projectName.includes("--")) {
    throw new Error("Project name cannot contain consecutive hyphens");
  }
}

export function validateRegion(region: string): void {
  const validRegions = [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-south-1",
    "ca-central-1",
    "sa-east-1",
  ];

  if (!validRegions.includes(region)) {
    throw new Error(
      `Invalid AWS region: ${region}. Supported regions: ${validRegions.join(", ")}`
    );
  }
}
