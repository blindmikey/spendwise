/* global parseCustomComponents */
// Runs at the end of <body>, after the x-component templates exist and before
// Alpine (deferred) boots - external file so the CSP can stay inline-script-free.
parseCustomComponents();
