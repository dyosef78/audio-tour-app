import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker, Polygon, Polyline, PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import type { RouteSource } from '../routing/routeDecision';
import type { LatLng, Waypoint } from '../types/domain';

/**
 * The tour map (PRD v2.0.0 Screen 3).
 *
 * 1. `showsUserLocation` is OFF. Enabling it makes the native map subscribe to
 *    the platform's own location service - a second GPS consumer alongside
 *    LocationService, which is hazard H5 from TASK-202, and a blue dot that can
 *    visibly disagree with the fix actually driving geofence triggers. The dot
 *    below is rendered from the store instead, so what you see is provably what
 *    the engine is acting on.
 *
 * 2. The line follows the ROUTE (TASK-604) - a live one through the selected
 *    stops, or the one from the offline bundle - already decoded and checked
 *    against the stops by RouteManager. Only when a tour has no route does it
 *    fall back to joining the stops directly, and then it is DASHED, so the
 *    placeholder cannot be mistaken for a path through the buildings.
 *
 * `waypoints` are the stops this session runs. Stops the preferences skipped
 * never reach this component, so their pins are simply absent while the
 * bundled route still runs past them.
 */

interface Props {
  waypoints: Waypoint[];
  route: LatLng[] | null;
  routeSource: RouteSource;
  currentFix: LatLng | null;
  activeWaypointId: string | null;
  visitedWaypointIds: string[];
  /**
   * Tapping a marker plays that stop immediately, bypassing the distance
   * check. Gated with the zone overlay behind one debug switch so both
   * disappear together when the switch is removed.
   */
  onWaypointPress?: (waypointId: string) => void;

  /** Debug overlay: geofence circles and polygons. */
  showZones: boolean;
}

const ROUTE_STYLE: Record<RouteSource, { color: string; width: number; dash?: number[] }> = {
  // Teal marks a route drawn for YOUR stops; ink, the tour's standard route.
  dynamic: { color: 'rgba(12,108,106,0.92)', width: 5 },
  static: { color: 'rgba(28,28,30,0.8)', width: 5 },
  straight: { color: 'rgba(28,28,30,0.55)', width: 3, dash: [10, 8] },
};

/** Bounding region over the stops AND the route, with padding. */
function regionFor(waypoints: Waypoint[], route: LatLng[] | null): Region | undefined {
  const points = [...waypoints.map((w) => w.coordinate), ...(route ?? [])];
  if (points.length === 0) return undefined;

  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // Floor the span so a single waypoint, or two very close ones, does not zoom
  // to a meaningless level. 0.004 deg is roughly 400 m of latitude.
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.004),
    longitudeDelta: Math.max((maxLon - minLon) * 1.6, 0.004),
  };
}

export default function TourMap({
  waypoints,
  route,
  routeSource,
  currentFix,
  activeWaypointId,
  visitedWaypointIds,
  showZones,
  onWaypointPress,
}: Props) {
  // Only initial: once the map is up the user owns the camera, and a live route
  // arriving later must not yank the view away from where they are looking.
  const region = regionFor(waypoints, route);

  const followsRoute = route !== null && route.length > 1;
  const line = followsRoute ? route : waypoints.map((w) => w.coordinate);
  const style = ROUTE_STYLE[followsRoute ? routeSource : 'straight'];

  return (
    <MapView
      style={StyleSheet.absoluteFill}
      // Apple Maps on iOS needs no API key; Google only where it is required.
      provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
      initialRegion={region}
      showsUserLocation={false}
      showsMyLocationButton={false}
      toolbarEnabled={false}
    >
      {line.length > 1 && (
        <Polyline
          // Keyed by source so a route swap replaces the native overlay rather
          // than mutating a dashed line into a solid one in place.
          key={`route:${followsRoute ? routeSource : 'straight'}`}
          coordinates={line}
          strokeWidth={style.width}
          strokeColor={style.color}
          lineDashPattern={style.dash}
          lineCap="round"
          lineJoin="round"
        />
      )}

      {showZones &&
        waypoints.map((w) => {
          const zone = w.geofence;
          if (!zone) return null;

          // The domain union maps one-to-one onto the two map primitives, which
          // is why no conversion layer is needed here.
          if (zone.zoneType === 'radius') {
            return (
              <Circle
                key={`${w.id}:zone`}
                center={zone.center}
                radius={zone.radiusMeters}
                strokeColor="rgba(12,108,106,0.9)"
                fillColor="rgba(12,108,106,0.14)"
                strokeWidth={2}
              />
            );
          }
          return (
            <Polygon
              key={`${w.id}:zone`}
              coordinates={zone.ring}
              strokeColor="rgba(12,108,106,0.9)"
              fillColor="rgba(12,108,106,0.14)"
              strokeWidth={2}
            />
          );
        })}

      {waypoints.map((w) => (
        <Marker
          key={w.id}
          coordinate={w.coordinate}
          title={w.name}
          description={w.poiType === 'transition' ? 'Navigation cue' : 'Tour stop'}
          onPress={onWaypointPress ? () => onWaypointPress(w.id) : undefined}
          pinColor={
            w.id === activeWaypointId
              ? 'green'
              : visitedWaypointIds.includes(w.id)
                ? 'gray'
                : 'red'
          }
        />
      ))}

      {currentFix && (
        // Our own dot, from the same fix the geofence engine consumed.
        <Marker coordinate={currentFix} anchor={{ x: 0.5, y: 0.5 }} flat tracksViewChanges={false}>
          <View style={styles.userDotHalo}>
            <View style={styles.userDot} />
          </View>
        </Marker>
      )}
    </MapView>
  );
}

const styles = StyleSheet.create({
  userDotHalo: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,122,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  userDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#007AFF', borderWidth: 2.5, borderColor: '#FFFFFF',
  },
});
