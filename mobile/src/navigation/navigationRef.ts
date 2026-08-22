import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootStackParamList } from './types';

/**
 * Imperative navigation handle.
 *
 * CORRECTION to the TASK-102 proposal: I suggested that placing the player
 * inside NavigationContainer would let it read route state "reactively" via
 * hooks. It does not. `useNavigation` and `useNavigationState` both require a
 * navigator or screen context, which a sibling of the Navigator does not have -
 * the same limitation as placing it outside the container entirely.
 *
 * So route awareness comes from NavigationContainer's `onStateChange` (see
 * RootNavigator), and navigation from this ref. The ref is needed regardless:
 * TourSessionController may eventually need to navigate and has no component
 * tree at all.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Navigate from anywhere, including non-React code. No-op until mounted. */
export function navigate<T extends keyof RootStackParamList>(
  ...args: undefined extends RootStackParamList[T]
    ? [screen: T] | [screen: T, params: RootStackParamList[T]]
    : [screen: T, params: RootStackParamList[T]]
): void {
  if (navigationRef.isReady()) {
    // @ts-expect-error - the conditional tuple above is correct at call sites,
    // but does not narrow to navigate()'s own overloads inside this wrapper.
    navigationRef.navigate(...args);
  }
}

/** Current route name, or undefined before the container is ready. */
export function currentRouteName(): string | undefined {
  return navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined;
}
