import { App } from "aws-cdk-lib";
import { OcGraphQLStack } from "../infrastructure/oc-graphql-stack";
import { SchemaParser } from "../parsers/schema-parser";
import { CodeGenerator } from "../generators/code-generator";
import * as fs from "fs-extra";
import * as path from "path";
import { execSync } from "child_process";

export interface DeployOptions {
  projectName: string;
  schemaFile: string;
  region: string;
  profile?: string;
  schema: string;
}

export async function deployGraphQLService(
  options: DeployOptions
): Promise<void> {
  const { projectName, schemaFile, region, profile, schema } = options;

  // Parse schema and extract metadata
  const parser = new SchemaParser(schema);
  const schemaMetadata = parser.parse();

  // Generate Lambda functions for resolvers
  const codeGenerator = new CodeGenerator(schemaMetadata, projectName);
  const generatedCode = await codeGenerator.generateAll();

  // Create temporary directory for generated code
  const tempDir = path.join(process.cwd(), ".oc-graphql-temp");
  await fs.ensureDir(tempDir);

  try {
    // Write generated Lambda functions
    for (const [fileName, code] of Object.entries(
      generatedCode.lambdaFunctions
    )) {
      await fs.writeFile(path.join(tempDir, fileName), code);
    }

    // Write processed schema
    await fs.writeFile(
      path.join(tempDir, "processed-schema.graphql"),
      generatedCode.processedSchema
    );

    // Create package.json for Lambda dependencies
    const packageJson = {
      name: "oc-graphql-lambdas",
      version: "1.0.0",
      description: "Generated Lambda functions for OC GraphQL",
      dependencies: {
        "@aws-sdk/client-dynamodb": "^3.0.0",
        "@aws-sdk/util-dynamodb": "^3.0.0",
        "@aws-sdk/client-athena": "^3.0.0",
        "@aws-sdk/client-s3": "^3.0.0",
        "@aws-sdk/client-glue": "^3.0.0",
        uuid: "^9.0.0",
      },
    };

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );

    // Install dependencies for Lambda functions
    console.log("📦 Installing Lambda dependencies...");
    try {
      execSync("npm install --production", {
        cwd: tempDir,
        stdio: "pipe",
      });
      console.log("✅ Lambda dependencies installed");
    } catch (error) {
      console.error("❌ Failed to install Lambda dependencies:", error);
      throw new Error("Dependency installation failed");
    }

    // Deploy CDK stack
    console.log("📦 Synthesizing CDK stack...");
    const app = new App();
    const stack = new OcGraphQLStack(app, `OcGraphql-${projectName}`, {
      projectName,
      schemaMetadata,
      generatedCodePath: tempDir,
      env: {
        region,
        account: process.env.CDK_DEFAULT_ACCOUNT,
      },
    });

    // Synthesize the stack
    const assembly = app.synth();

    // Bootstrap CDK if needed
    console.log("🔧 Checking CDK bootstrap...");
    try {
      const bootstrapCmd = `cdk bootstrap aws://unknown-account/${region}${profile ? ` --profile ${profile}` : ""}`;
      execSync(bootstrapCmd, {
        stdio: "pipe",
        env: { ...process.env, CDK_DEFAULT_REGION: region },
      });
      console.log("✅ CDK bootstrap completed");
    } catch (error) {
      // Bootstrap might fail if already done, which is OK
      console.log("ℹ️ CDK bootstrap skipped (likely already done)");
    }

    // Deploy the stack
    console.log("🚀 Deploying to AWS...");
    console.log("⏳ This may take 5-15 minutes depending on the resources...");

    const deployCmd = `cdk deploy ${stack.stackName} --app "${assembly.directory}" --require-approval never --progress events${profile ? ` --profile ${profile}` : ""}`;

    try {
      execSync(deployCmd, {
        stdio: "inherit",
        env: { ...process.env, CDK_DEFAULT_REGION: region },
        timeout: 20 * 60 * 1000, // 20 minute timeout
      });

      console.log("\n✅ Deployment completed successfully!");

      // Get stack outputs
      console.log("\n🎉 Your GraphQL API is ready!");
      console.log("📍 Resources created:");
      console.log(`   • Stack Name: ${stack.stackName}`);
      console.log(`   • Region: ${region}`);
      console.log(`   • DynamoDB Table: ${projectName}`);
      console.log(`   • S3 Data Bucket: ${projectName}-{account-id}`);
      console.log(`   • Athena Database: ${projectName}_db`);
      console.log("\n🔗 Next steps:");
      console.log(
        "   1. Check AWS AppSync Console for your GraphQL API endpoint"
      );
      console.log("   2. Use the API key from AppSync for authentication");
      console.log("   3. Test your API using the GraphQL playground");
    } catch (error) {
      console.error("\n❌ Deployment failed!");
      if (error instanceof Error) {
        if (error.message.includes("timeout")) {
          throw new Error(
            "Deployment timed out. This can happen with complex stacks. Check AWS CloudFormation console for status."
          );
        } else if (error.message.includes("credentials")) {
          throw new Error(
            "AWS credentials issue. Please ensure you have valid AWS credentials configured."
          );
        } else {
          throw new Error(`CDK deployment failed: ${error.message}`);
        }
      }
      throw new Error("CDK deployment failed with unknown error");
    }
  } finally {
    // Cleanup temporary directory
    await fs.remove(tempDir);
  }
}
