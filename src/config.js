import os from 'node:os';
import path from 'node:path';

export const BASE_URL = 'https://minerva.leeds.ac.uk';
export const HOST = 'minerva.leeds.ac.uk';

// Sessions and browser profiles live outside the project so the project folder
// can be shared or committed without leaking a login. Each account has its own
// folder under DATA_DIR/accounts (see accounts.js).
export const DATA_DIR = process.env.MINERVA_MCP_HOME || path.join(os.homedir(), '.minerva-mcp');
export const GS_BASE_URL = 'https://www.gradescope.com';
export const GS_HOST = 'www.gradescope.com';
// Gradescope's "School Credentials" entry for the University of Leeds. It signs
// in through the same Microsoft account as Minerva.
export const GS_SSO_PATH = process.env.GRADESCOPE_SSO_PATH || '/auth/saml/ae954ab5-1840-431e-a2ca-dc881c5358ed';
export const DOWNLOAD_DIR =process.env.MINERVA_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'minerva');
