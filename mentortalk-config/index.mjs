import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({ region: "ap-south-1" });
const TABLE_NAME = "mentortalk-app-config";

export const handler = async (event) => {
  try {
    const platform = event.queryStringParameters?.platform || "android";
    const app = event.queryStringParameters?.app || null;
    const versionKey = platform === "ios" ? "min_app_version_ios" : "min_app_version_android";

    const [versionResult, maintenanceResult, flagsResult] = await Promise.all([
      dynamodb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { config_key: { S: versionKey } }
      })),
      dynamodb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { config_key: { S: "maintenance_mode" } }
      })),
      dynamodb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { config_key: { S: "feature_flags" } }
      })),
    ]);

    const versionData = JSON.parse(versionResult.Item?.value?.S || '{"version":"1.0.0","force":false}');
    const maintenanceData = JSON.parse(maintenanceResult.Item?.value?.S || '{"enabled":false,"message":""}');

    // Per-app config: if app param provided and nested structure exists, use it
    // Falls back to global (backward compatible)
    let minVersion, forceUpdate, maintenanceEnabled, maintenanceMessage;

    if (app && versionData[app]) {
      minVersion = versionData[app].version || "1.0.0";
      forceUpdate = versionData[app].force || false;
    } else if (versionData.version) {
      // Legacy flat structure
      minVersion = versionData.version;
      forceUpdate = versionData.force || false;
    } else {
      minVersion = "1.0.0";
      forceUpdate = false;
    }

    if (app && maintenanceData[app]) {
      maintenanceEnabled = maintenanceData[app].enabled || false;
      maintenanceMessage = maintenanceData[app].message || "";
    } else if (maintenanceData.enabled !== undefined) {
      // Legacy flat structure
      maintenanceEnabled = maintenanceData.enabled;
      maintenanceMessage = maintenanceData.message || "";
    } else {
      maintenanceEnabled = false;
      maintenanceMessage = "";
    }

    const featureFlags = JSON.parse(flagsResult.Item?.value?.S || '{}');

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        min_version: minVersion,
        force_update: forceUpdate,
        maintenance_mode: maintenanceEnabled,
        maintenance_message: maintenanceMessage,
        feature_flags: featureFlags,
      })
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        min_version: "1.0.0",
        force_update: false,
        maintenance_mode: false,
        maintenance_message: "",
        feature_flags: {},
      })
    };
  }
};