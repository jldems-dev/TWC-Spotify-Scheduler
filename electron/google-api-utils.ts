export function googleApiError(status: number, message: string): Error {
  if (status === 429 || /quota|resource_exhausted/i.test(message)) return new Error("Google Business Profile locations are unavailable because this Google Cloud project has no API quota (limit: 0). Request Google Cloud quota or API access approval for mybusinessaccountmanagement.googleapis.com, then try loading locations again.");
  if (status === 403) return new Error(/has not been used|disabled|accessNotConfigured/i.test(message)
    ? "Google Business Profile API access is not approved or the API is not enabled for this project."
    : `Google permission denied: ${message}`);
  if (status === 404) return new Error("Business location or hours are unavailable. Check the selected location and Business Profile permissions.");
  if (status === 401) return new Error("Google access was revoked or expired. Reconnect the account.");
  return new Error(message || `Google API returned ${status}`);
}
