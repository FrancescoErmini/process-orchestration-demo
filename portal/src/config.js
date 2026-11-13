// Central configuration. Everything can be overridden through environment variables.
const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  camunda: {
    // Internal URL (container network) used for REST calls
    restUrl: env.CAMUNDA_REST_URL || 'http://localhost:8080',
    // Public URL (browser) used for links to Tasklist / Operate
    publicUrl: env.CAMUNDA_PUBLIC_URL || 'http://localhost:8080',
    // Technical account used by the job workers and for deployment
    serviceUser: env.CAMUNDA_SERVICE_USER || 'demo',
    servicePassword: env.CAMUNDA_SERVICE_PASSWORD || 'demo',
  },
  db: {
    connectionString: env.DATABASE_URL || 'postgres://hcp:hcp@localhost:5432/hcp',
  },
  processDir: env.PROCESS_DIR || require('path').join(__dirname, '..', '..', 'process'),
  processId: 'hcp-speaker-event',

  // Demo personas. Credentials are the Camunda users (see camunda/application.yaml);
  // the portal authenticates every login against Camunda.
  personas: {
    marco: { role: 'marketing', group: 'medical-marketing', title: 'Brand Manager · Medical Marketing' },
    clara: { role: 'compliance', group: 'compliance', title: 'Compliance Officer' },
    elena: { role: 'coordinator', group: 'event-coordination', title: 'Event Coordinator' },
    fabio: { role: 'finance', group: 'finance', title: 'Finance · Honorarium Payments' },
    demo: { role: 'admin', group: null, title: 'Demo Administrator (sees everything)' },
  },

  // Fair Market Value limits per speaker tier (EUR per engagement)
  fmvLimits: {
    'Local HCP': 600,
    'Regional KOL': 900,
    'National KOL': 1200,
    'International KOL': 2500,
  },
};
