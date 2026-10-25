import os from 'node:os';
import path from 'node:path';

export const BASE_URL = 'https://minerva.leeds.ac.uk';
export const HOST = 'minerva.leeds.ac.uk';

// Session cookies and the browser profile live outside the project so the
// project folder can be shared or committed without leaking a login.
export const DATA_DIR = process.env.MINERVA_MCP_HOME || path.join(os.homedir(), '.minerva-mcp');
export const SESSION_FILE = path.join(DATA_DIR, 'session.json');
export const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
export const GS_BASE_URL = 'https://www.gradescope.com';
export const GS_HOST = 'www.gradescope.com';
export const GS_SESSION_FILE = path.join(DATA_DIR, 'gradescope-session.json');
// Gradescope's "School Credentials" entry for the University of Leeds. It signs
// in through the same Microsoft account as Minerva.
export const GS_SSO_PATH = process.env.GRADESCOPE_SSO_PATH || '/auth/saml/ae954ab5-1840-431e-a2ca-dc881c5358ed';
export const DOWNLOAD_DIR =process.env.MINERVA_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'minerva');
