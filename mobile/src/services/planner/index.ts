import { accessTokenForRequest } from '../auth/AccountService';
import { supabaseEndpoint } from '../supabase/client';
import { createPlanClient } from './PlanClient';

/** The app's plan-tour client, wired to the real endpoint and session. */
export const planClient = createPlanClient({
  baseUrl: supabaseEndpoint.url ?? '',
  anonKey: supabaseEndpoint.anonKey ?? '',
  accessToken: accessTokenForRequest,
});
