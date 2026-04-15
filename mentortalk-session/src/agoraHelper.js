import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pkg from "agora-token";
const { RtcTokenBuilder, RtcRole } = pkg;

const secretsClient = new SecretsManagerClient({ region: "ap-south-1" });

let agoraCredentials = null;

async function getAgoraCredentials() {
  if (agoraCredentials) return agoraCredentials;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: "mentortalk/agora-credentials" })
  );
  agoraCredentials = JSON.parse(response.SecretString);
  return agoraCredentials;
}

/**
 * Generate an Agora RTC token for a 1:1 call.
 *
 * @param {string} sessionId - Used to derive the channel name: "ses_{sessionId}"
 * @param {number} uid - Unique integer per user in the channel (1 = mentor, 2 = mentee)
 * @param {number} [expirationSeconds=3600] - Token validity (default 1 hour)
 * @returns {Promise<{ token: string, channel: string, uid: number, app_id: string }>}
 */
export async function generateAgoraToken(sessionId, uid, expirationSeconds = 3600) {
  const creds = await getAgoraCredentials();
  const channel = `ses_${sessionId}`;

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    creds.app_id,
    creds.app_certificate,
    channel,
    uid,
    RtcRole.PUBLISHER,
    privilegeExpiredTs
  );

  return { token, channel, uid, app_id: creds.app_id };
}