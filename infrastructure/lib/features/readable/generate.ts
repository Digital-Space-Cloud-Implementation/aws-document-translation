// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

import {
	aws_dynamodb as dynamodb,
	aws_iam as iam,
	aws_stepfunctions as sfn,
	aws_stepfunctions_tasks as tasks,
	aws_lambda as lambda,
	aws_lambda_event_sources as eventsources,
	aws_appsync as appsync,
	aws_s3 as s3,
} from "aws-cdk-lib";

import * as dt_enums from "./enum";
import { dt_stepfunction } from "../../components/stepfunction";
import { dt_lambda } from "../../components/lambda";

import { dt_readableWorkflow as dt_readableWorkflow_amazon_titanText } from "./vendor/amazon_titanText";
import { dt_readableWorkflow as dt_readableWorkflow_anthropic_claudeText } from "./vendor/anthropic_claudeText";
import { dt_readableWorkflow as dt_readableWorkflow_stabilityai_stableDiffusion } from "./vendor/stabilityai_stableDiffusion";

export interface props {
	contentBucket: s3.Bucket;
	removalPolicy: cdk.RemovalPolicy;
}

export class dt_readableWorkflowGenerate extends Construct {
	public readonly sfnMain: sfn.StateMachine;

	constructor(scope: Construct, id: string, props: props) {
		super(scope, id);

		// LAMBDA
		// LAMBDA | INVOKE BEDROCK
		// LAMBDA | INVOKE BEDROCK | ROLE
		const invokeBedrockLambdaRole = new iam.Role(
			this,
			"invokeBedrockLambdaRole",
			{
				// ASM-L6 // ASM-L8
				assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
				description: "Lambda Role (Invoke Bedrock API)",
			},
		);

		// LAMBDA | INVOKE BEDROCK | POLICY
		const permitInvokeBedrockModel = new iam.Policy(
			this,
			"permitSfnSendSuccess",
			{
				policyName: "Send-Sfn-task-success-to-Sfn-Service",
				statements: [
					new iam.PolicyStatement({
						// ASM-IAM
						actions: ["bedrock:InvokeModel"],
						resources: [
							"arn:aws:bedrock:*::foundation-model/*", // Foundational Models
							`arn:aws:bedrock:*:${cdk.Stack.of(this).account}:custom-model/*`,
						],
					}),
				],
			},
		);
		invokeBedrockLambdaRole.attachInlinePolicy(permitInvokeBedrockModel);
		NagSuppressions.addResourceSuppressions(
			permitInvokeBedrockModel,
			[
				{
					id: "AwsSolutions-IAM5",
					reason: "Preferred model for prompt is unknown at deploy time",
					appliesTo: ["Resource::arn:aws:bedrock:*::foundation-model/*"],
				},
				{
					id: "AwsSolutions-IAM5",
					reason: "User provided model for prompt is unknown at deploy time",
					appliesTo: [
						"Resource::arn:aws:bedrock:*:<AWS::AccountId>:custom-model/*",
					],
				},
			],
			true,
		);

		// LAMBDA | INVOKE BEDROCK | FUNCTION
		const invokeBedrockLambda = new dt_lambda(this, "invokeBedrockLambda", {
			role: invokeBedrockLambdaRole,
			path: "lambda/invokeBedrock",
			description: "Invoke Bedrock API",
			environment: {
				BEDROCK_REGION: "us-west-2",
			},
			bundlingNodeModules: ["@aws-sdk/client-bedrock-runtime"],
			timeout: cdk.Duration.seconds(60),
		});

		//
		// MODEL WORKFLOWS
		// MODEL WORKFLOWS | CHOICE
		const modelChoice = new sfn.Choice(this, "modelChoice");
		// MODEL CHOICE | UNRECOGNISED
		// const updateDbUnrecognisedModel = new tasks.LambdaInvoke(
		// 	this,
		// 	"updateDbUnrecognisedModel",
		// 	{
		// 		lambdaFunction: updateDbLambda.lambdaFunction,
		// 		resultSelector: {
		// 			"Payload.$": "$.Payload",
		// 		},
		// 		resultPath: "$.updateDbUnrecognisedModel",
		// 		payload: sfn.TaskInput.fromObject({
		// 			id: sfn.JsonPath.objectAt("$.jobDetails.id"),
		// 			itemId: sfn.JsonPath.objectAt("$.jobDetails.itemId"),
		// 			status: dt_enums.ItemStatus.FAILED_UNRECOGNISEDMODEL,
		// 		}),
		// 	},
		// );
		const failUnrecognisedModel = new sfn.Fail(this, "failUnrecognisedModel", {
			error: dt_enums.ItemStatus.FAILED_UNRECOGNISEDMODEL,
			causePath: sfn.JsonPath.format(
				"Workflow does not recognise modelId of '{}'",
				sfn.JsonPath.stringAt("$.jobDetails.modelId"),
			),
		});

		// MODEL WORKFLOWS | TEXT | AMAZON
		const workflow_amazon = new dt_readableWorkflow_amazon_titanText(
			this,
			"workflow_amazon",
			{
				invokeBedrockLambda: invokeBedrockLambda.lambdaFunction,
				removalPolicy: props.removalPolicy,
			},
		);
		// MODEL WORKFLOWS | TEXT | ANTHRHOPIC
		const workflow_anthropic = new dt_readableWorkflow_anthropic_claudeText(
			this,
			"workflow_anthropic",
			{
				invokeBedrockLambda: invokeBedrockLambda.lambdaFunction,
				removalPolicy: props.removalPolicy,
			},
		);
		// MODEL WORKFLOWS | IMAGE | STABILITYAI
		const workflow_stabilityai =
			new dt_readableWorkflow_stabilityai_stableDiffusion(
				this,
				"workflow_stabilityai",
				{
					// invokeBedrockLambda: invokeBedrockLambda.lambdaFunction,
					contentBucket: props.contentBucket,
					removalPolicy: props.removalPolicy,
				},
			);

		//
		// STATE MACHINE
		// STATE MACHINE | DEF
		this.sfnMain = new dt_stepfunction(
			this,
			`${cdk.Stack.of(this).stackName}_ReadableGenerate`,
			{
				nameSuffix: "ReadableGenerate",
				removalPolicy: props.removalPolicy,
				definition: modelChoice
					.when(
						workflow_amazon.modelChoiceCondition,
						workflow_amazon.invokeModel,
					)
					.when(
						workflow_anthropic.modelChoiceCondition,
						workflow_anthropic.invokeModel,
					)
					.when(
						workflow_stabilityai.modelChoiceCondition,
						workflow_stabilityai.invokeModel,
					)
					.otherwise(failUnrecognisedModel),
			},
		).StateMachine;

		NagSuppressions.addResourceSuppressions(
			this.sfnMain,
			[
				{
					id: "AwsSolutions-IAM5",
					reason:
						"Permission scoped to project specific resources. Execution ID unknown at deploy time.",
					appliesTo: [
						'Resource::arn:<AWS::Partition>:states:<AWS::Region>:<AWS::AccountId>:execution:{"Fn::Select":[6,{"Fn::Split":[":",{"Ref":"basereadablereadableWorkflowworkflowGenerateworkflowamazonDocTrandevappReadableamazon54A47EFF"}]}]}*',
						'Resource::arn:<AWS::Partition>:states:<AWS::Region>:<AWS::AccountId>:execution:{"Fn::Select":[6,{"Fn::Split":[":",{"Ref":"basereadablereadableWorkflowworkflowGenerateworkflowanthropicDocTrandevappReadableanthropic2938CF7A"}]}]}*',
						'Resource::arn:<AWS::Partition>:states:<AWS::Region>:<AWS::AccountId>:execution:{"Fn::Select":[6,{"Fn::Split":[":",{"Ref":"basereadablereadableWorkflowworkflowGenerateworkflowstabilityaiDocTrandevappReadablestability2E369112"}]}]}*',
					],
				},
			],
			true,
		);
		// END
	}
}
