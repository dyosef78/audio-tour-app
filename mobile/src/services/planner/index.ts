import { accessTokenForRequest } from '../auth/AccountService';
import { supabaseEndpoint } from '../supabase/client';
import { createPlacesClient } from './places';
import { createPlanClient } from './PlanClient';

/** The app's plan-tour client, wired to the real endpoint and session. */
export const planClient = createPlanClient({
  baseUrl: supabaseEndpoint.url ?? '',
  anonKey: supabaseEndpoint.anonKey ?? '',
  accessToken: accessTokenForRequest,
});

/** The places-search proxy (the Google key never ships in the app). */
export const placesClient = createPlacesClient({
  baseUrl: supabaseEndpoint.url ?? '',
  anonKey: supabaseEndpoint.anonKey ?? '',
  accessToken: accessTokenForRequest,
});
