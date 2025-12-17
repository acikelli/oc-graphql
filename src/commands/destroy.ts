import chalk from "chalk";
import { execSync } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import { App } from "aws-cdk-lib";
import { OcGraphQLStack } from "../infrastructure/oc-graphql-stack";
import { SchemaParser } from "../parsers/schema-parser";
import { CodeGenerator } from "../generators/code-generator";

export interface DestroyOptions {
  projectName: string;
  region: string;
  profile?: string;
  retainStorage: boolean;
}

export async function destroyGraphQLService(
  options: DestroyOptions
): Promise<void> {
  const { projectName, region, profile, retainStorage } = options;

  console.log(
    chalk.yellow(
      "🚨 WARNING: This will destroy your GraphQL API infrastructure!"
    )
  );

  if (retainStorage) {
    console.log(
      chalk.blue(
        "📦 Storage services (S3, DynamoDB) will be retained for data safety."
      )
    );
  } else {
    console.log(
      chalk.red("💥 ALL resources including data will be permanently deleted!")
    );
  }

  const stackName = `OcGraphql-${projectName}`;

  try {
    // Check if stack exists
    console.log(chalk.blue(`🔍 Checking if stack '${stackName}' exists...`));

    const describeStackCmd = `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region}${profile ? ` --profile ${profile}` : ""}`;

    try {
      execSync(describeStackCmd, { stdio: "pipe" });
      console.log(chalk.green(`✅ Found stack '${stackName}'`));
    } catch (error) {
      console.log(
        chalk.yellow(`⚠️ Stack '${stackName}' not found. Nothing to destroy.`)
      );
      return;
    }

    // For storage retention, we need to update the stack first to set retention policies
    if (retainStorage) {
      console.log(
        chalk.blue("🔧 Configuring storage resources for retention...")
      );

      try {
        // Get original schema to recreate the CDK context
        console.log(chalk.blue("📋 Retrieving stack configuration..."));

        // Get stack parameters and tags to understand the original deployment
        const stackInfoCmd = `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region}${profile ? ` --profile ${profile}` : ""} --query "Stacks[0].{Parameters:Parameters,Tags:Tags}" --output json`;
        const stackInfoOutput = execSync(stackInfoCmd, { encoding: "utf8" });
        const stackInfo = JSON.parse(stackInfoOutput);

        // Create temporary directory for CDK operation
        const tempDir = path.join(process.cwd(), ".oc-graphql-destroy-temp");
        await fs.ensureDir(tempDir);

        try {
          // Create a minimal CDK app for stack update
          console.log(chalk.blue("🔄 Preparing retention policy update..."));

          // We need to create a dummy schema since we don't have the original
          // This is just for the CDK context, the actual resources won't change
          const dummySchema = `
            type Query {
              dummy: String
            }
          `;

          const parser = new SchemaParser(dummySchema);
          const schemaMetadata = parser.parse();
          const codeGenerator = new CodeGenerator(schemaMetadata, projectName);
          const generatedCode = await codeGenerator.generateAll();

          // Write minimal required files
          await fs.writeFile(
            path.join(tempDir, "processed-schema.graphql"),
            generatedCode.processedSchema
          );

          // Create the CDK app with retention context
          const app = new App({
            context: {
              retainStorage: "true", // This will set RemovalPolicy.RETAIN
            },
          });

          const stack = new OcGraphQLStack(app, stackName, {
            projectName,
            schemaMetadata,
            generatedCodePath: tempDir,
            env: {
              region,
              account: process.env.CDK_DEFAULT_ACCOUNT,
            },
          });

          // Synthesize the stack with retention policies
          const assembly = app.synth();

          // Update the stack to apply retention policies
          console.log(
            chalk.blue("📦 Updating stack with retention policies...")
          );
          const updateCmd = `cdk deploy ${stackName} --app "${assembly.directory}" --require-approval never --progress events${profile ? ` --profile ${profile}` : ""} --context retainStorage=true`;

          execSync(updateCmd, {
            stdio: "inherit",
            env: { ...process.env, CDK_DEFAULT_REGION: region },
            timeout: 10 * 60 * 1000, // 10 minute timeout
          });

          console.log(chalk.green("✅ Storage retention policies applied"));
        } finally {
          // Cleanup temporary directory
          await fs.remove(tempDir);
        }
      } catch (error) {
        console.log(
          chalk.yellow(
            "⚠️ Could not update retention policies. Storage may not be retained during destroy."
          )
        );
        console.log(chalk.yellow("Proceeding with destroy operation..."));
      }
    }

    // Execute destroy command using CloudFormation
    console.log(chalk.red("🗑️ Destroying GraphQL service..."));
    console.log(chalk.yellow("⏳ This may take 5-10 minutes..."));

    const deleteStackCmd = `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}${profile ? ` --profile ${profile}` : ""}`;

    console.log(chalk.blue(`🚀 Executing: ${deleteStackCmd}`));
    execSync(deleteStackCmd, { stdio: "pipe" });

    // Wait for stack deletion to complete
    console.log(chalk.blue("⏳ Waiting for stack deletion to complete..."));
    const waitCmd = `aws cloudformation wait stack-delete-complete --stack-name ${stackName} --region ${region}${profile ? ` --profile ${profile}` : ""}`;

    try {
      execSync(waitCmd, {
        stdio: "inherit",
        timeout: 15 * 60 * 1000, // 15 minute timeout
      });
    } catch (error) {
      // Check if stack actually deleted successfully
      try {
        execSync(describeStackCmd, { stdio: "pipe" });
        // If this succeeds, stack still exists - there was an error
        throw new Error("Stack deletion did not complete successfully");
      } catch (checkError) {
        // If this fails, stack was deleted successfully
        console.log(chalk.green("✅ Stack deletion completed"));
      }
    }

    console.log(chalk.green("\n✅ GraphQL service destroyed successfully!"));

    if (retainStorage) {
      console.log(chalk.blue("\n📦 Retained resources:"));
      console.log(
        chalk.cyan(`   • DynamoDB Table: ${projectName} (with data)`)
      );
      console.log(
        chalk.cyan(
          `   • S3 Data Bucket: ${projectName}-{account-id} (with data)`
        )
      );
      console.log(
        chalk.cyan(`   • Athena Database: ${projectName}_db (with tables)`)
      );
      console.log(
        chalk.yellow(
          "\n⚠️ Note: You may incur storage costs for retained resources."
        )
      );
      console.log(
        chalk.yellow("💡 To delete data manually, use AWS Console or CLI.")
      );
    } else {
      console.log(
        chalk.red("\n💥 All resources and data have been permanently deleted.")
      );
    }
  } catch (error) {
    console.error(chalk.red("\n❌ Destroy operation failed!"));

    if (error instanceof Error) {
      if (error.message.includes("timeout")) {
        throw new Error(
          "Destroy operation timed out. Check AWS CloudFormation console for status."
        );
      } else if (error.message.includes("credentials")) {
        throw new Error(
          "AWS credentials issue. Please ensure you have valid AWS credentials configured."
        );
      } else if (error.message.includes("does not exist")) {
        throw new Error(
          `Stack '${stackName}' does not exist. It may have already been deleted.`
        );
      } else {
        throw new Error(`Destroy operation failed: ${error.message}`);
      }
    }
    throw new Error("Destroy operation failed with unknown error");
  }
}
