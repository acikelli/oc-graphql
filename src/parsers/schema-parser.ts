import {
  parse,
  DocumentNode,
  DefinitionNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  DirectiveNode,
  ArgumentNode,
  StringValueNode,
  EnumTypeDefinitionNode,
} from "graphql";

export interface SqlQueryDirective {
  query: string;
}

export interface ResolverDirective {
  enabled: boolean;
}

export interface ReturnDirective {
  value: string;
}

export interface ArgumentMetadata {
  name: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
}

export interface FieldMetadata {
  name: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
  arguments?: ArgumentMetadata[];
  sqlQuery?: SqlQueryDirective;
  returnValue?: ReturnDirective;
  isTask?: boolean;
}

export interface TypeMetadata {
  name: string;
  fields: FieldMetadata[];
  isResolver?: boolean;
  isPrimitive: boolean;
  isTaskResponse?: boolean;
}

export interface SchemaMetadata {
  types: TypeMetadata[];
  queries: FieldMetadata[];
  mutations: FieldMetadata[];
  enums: string[];
  joinTables: string[];
}

export class SchemaParser {
  private document: DocumentNode;

  constructor(private schema: string) {
    this.document = parse(schema);
  }

  parse(): SchemaMetadata {
    const types: TypeMetadata[] = [];
    const queries: FieldMetadata[] = [];
    const mutations: FieldMetadata[] = [];
    const enums: string[] = [];
    const joinTables = new Set<string>();

    for (const definition of this.document.definitions) {
      if (definition.kind === "ObjectTypeDefinition") {
        const typeDef = definition as ObjectTypeDefinitionNode;

        if (typeDef.name.value === "Query") {
          queries.push(...this.parseFields(typeDef.fields || [], joinTables));
        } else if (typeDef.name.value === "Mutation") {
          mutations.push(...this.parseFields(typeDef.fields || [], joinTables));
        } else {
          types.push(this.parseType(typeDef, joinTables));
        }
      } else if (definition.kind === "EnumTypeDefinition") {
        const enumDef = definition as EnumTypeDefinitionNode;
        enums.push(enumDef.name.value);
      }
    }

    return {
      types,
      queries,
      mutations,
      enums,
      joinTables: Array.from(joinTables),
    };
  }

  private parseType(
    typeDef: ObjectTypeDefinitionNode,
    joinTables: Set<string>
  ): TypeMetadata {
    const isResolver = this.hasDirective("resolver", typeDef.directives);
    const isTaskResponse = this.hasDirective(
      "task_response",
      typeDef.directives
    );
    const isPrimitive = this.isPrimitiveType(typeDef.name.value);

    return {
      name: typeDef.name.value,
      fields: this.parseFields(typeDef.fields || [], joinTables),
      isResolver,
      isPrimitive,
      isTaskResponse,
    };
  }

  private parseFields(
    fields: readonly FieldDefinitionNode[],
    joinTables: Set<string>
  ): FieldMetadata[] {
    return fields.map((field) => {
      const fieldType = this.extractFieldType(field.type);
      const sqlQuery = this.extractSqlQueryDirective(field.directives);
      const returnValue = this.extractReturnDirective(field.directives);
      const fieldArguments = this.extractFieldArguments(field.arguments);
      const isTask = this.hasDirective("task", field.directives);

      // Extract join tables from SQL queries
      if (sqlQuery?.query) {
        this.extractJoinTablesFromQuery(sqlQuery.query, joinTables);
      }

      return {
        name: field.name.value,
        type: fieldType.type,
        isRequired: fieldType.isRequired,
        isList: fieldType.isList,
        arguments: fieldArguments.length > 0 ? fieldArguments : undefined,
        sqlQuery,
        returnValue,
        isTask,
      };
    });
  }

  private extractFieldType(type: any): {
    type: string;
    isRequired: boolean;
    isList: boolean;
  } {
    let isRequired = false;
    let isList = false;
    let typeName = "";

    if (type.kind === "NonNullType") {
      isRequired = true;
      type = type.type;
    }

    if (type.kind === "ListType") {
      isList = true;
      type = type.type;

      if (type.kind === "NonNullType") {
        type = type.type;
      }
    }

    typeName = type.name.value;

    return { type: typeName, isRequired, isList };
  }

  private extractSqlQueryDirective(
    directives?: readonly DirectiveNode[]
  ): SqlQueryDirective | undefined {
    const directive = this.findDirective("sql_query", directives);
    if (!directive) return undefined;

    const queryArg = this.findArgument("query", directive.arguments);

    return {
      query: this.getStringValue(queryArg?.value),
    };
  }

  private extractReturnDirective(
    directives?: readonly DirectiveNode[]
  ): ReturnDirective | undefined {
    const directive = this.findDirective("return", directives);
    if (!directive) return undefined;

    // Extract the return expression (e.g., args.limit)
    const value = directive.arguments?.[0]?.value;
    return {
      value: this.getStringValue(value) || "",
    };
  }

  private extractJoinTablesFromQuery(
    query: string,
    joinTables: Set<string>
  ): void {
    const joinTableRegex = /\$join_table\(([^)]+)\)/g;
    let match;

    while ((match = joinTableRegex.exec(query)) !== null) {
      joinTables.add(match[1]);
    }
  }

  private extractFieldArguments(args?: readonly any[]): ArgumentMetadata[] {
    if (!args || args.length === 0) return [];

    return args.map((arg) => {
      const argType = this.extractFieldType(arg.type);
      return {
        name: arg.name.value,
        type: argType.type,
        isRequired: argType.isRequired,
        isList: argType.isList,
      };
    });
  }

  private hasDirective(
    name: string,
    directives?: readonly DirectiveNode[]
  ): boolean {
    return this.findDirective(name, directives) !== undefined;
  }

  private findDirective(
    name: string,
    directives?: readonly DirectiveNode[]
  ): DirectiveNode | undefined {
    return directives?.find((d) => d.name.value === name);
  }

  private findArgument(
    name: string,
    args?: readonly ArgumentNode[]
  ): ArgumentNode | undefined {
    return args?.find((arg) => arg.name.value === name);
  }

  private getStringValue(value?: any): string {
    if (value?.kind === "StringValue") {
      return (value as StringValueNode).value;
    }
    return "";
  }

  private getBooleanValue(value?: any): boolean {
    if (value?.kind === "BooleanValue") {
      return value.value;
    }
    return false;
  }

  private isPrimitiveType(typeName: string): boolean {
    const primitiveTypes = [
      "String",
      "Int",
      "Float",
      "Boolean",
      "ID",
      "AWSDateTime",
    ];
    return primitiveTypes.includes(typeName);
  }
}
