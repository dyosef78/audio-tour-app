import type { LatLng } from '../types/domain';

/**
 * What the active-tour map draws (Epic 16: the client is a dumb executor).
 *
 * The app plans nothing and calls no routing service. It draws one of two
 * things, both decided at session start (TourSessionController.publishStaticRoute):
 *
 *   static    the tour's authored route from the offline bundle, validated
 *             against the session's stops (routeGeometry.decodeRoute)
 *   straight  no usable route: the stops joined in authored order, drawn
 *             dashed so nobody mistakes the lines for a path
 *
 * Between chapters the visitor is handed to Google Maps / Waze, which does
 * the real routing. TASK-604's live "dynamic" route, the on-device Smart
 * Sorter prediction and the route cache were deleted in Epic 16.
 */
export type RouteSource = 'static' | 'straight';

export interface RouteDisplay {
  source: RouteSource;
  /** Null for 'straight': the map joins the stops itself. */
  points: LatLng[] | null;
}
