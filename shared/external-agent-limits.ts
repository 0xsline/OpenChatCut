/** Small control requests must stay cheap to parse and retain. */
export const EXTERNAL_AGENT_CONTROL_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** Editor tool results may contain a bounded batch of base64 image frames. */
export const EXTERNAL_AGENT_RESULT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** Leave JSON-envelope headroom below the result request limit. */
export const EXTERNAL_AGENT_IMAGE_PAYLOAD_LIMIT_BYTES = 12 * 1024 * 1024;
