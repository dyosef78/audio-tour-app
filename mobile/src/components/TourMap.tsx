import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker, Polygon, Polyline, PROVIDER_GOOGLE, type Region } from 'react-native-maps';

import type { LatLng, Waypoint } from '../types/domain';

/**
 * The tour map (PRD v2.0.0 Screen 3).
 *
 * Two deliberate decisions, both approved in the TASK-102 proposal:
 *
 * 1. `showsUserLocation` is OFF. Enabling it makes the native map subscribe to
 *    the platform's own location service - a second GPS consumer alongside
 *    LocationService, which is hazard H5 from TASK-202, and a blue dot that can
 *    visibly disagree with the fix actually driving geofence triggers. The dot
 *    below is rendered from the store instead, so what you see is provably what
 *    the engine is acting on.
 *
 * 2. The polyline joins waypoints with straight segments. There is no routing
 *    engine yet (PRD Flow Step 3), so this cuts through buildings. Approved as
 *    MVP, but it is a placeholder, not a route.
 */

interface Props {
  waypoints: Waypoint[];
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

/** Bounding region over the tour, with padding so pins are not on the edge. */
function regionFor(waypoints: Waypoint[]): Region | undefined {
  if (waypoints.length === 0) return undefined;

  const lats = waypoints.map((w) => w.coordinate.latitude);
  const lons = waypoints.map((w) => w.coordinate.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // Floor the span so a single waypoint, or two very close ones, does not zoom
  // to a meaningless level. 0.004 deg is roughly 400 m of latitude.
  const latitudeDelta = Math.max((maxLat - minLat) * 1.6, 0.004);
  const longitudeDelta = Math.max((maxLon - minLon) * 1.6, 0.004);

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta,
    longitudeDelta,
  };
}

export default function TourMap({
  waypoints,
  currentFix,
  activeWaypointId,
  visitedWaypointIds,
  showZones,
  onWaypointPress,
}: Props) {
  const region = regionFor(waypoints);
  const route = waypoints.map((w) => w.coordinate);

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
      {route.length > 1 && (
        <Polyline coordinates={route} strokeWidth={4} strokeColor="rgba(28,28,30,0.75)" />
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
