import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/**
 * Route table for the root stack.
 *
 * Params are deliberately minimal - an id plus whatever the destination needs
 * for its header before data loads. Passing whole objects through navigation
 * params would let a stale copy of a tour outlive the fetch that produced it.
 */

/** `editing` when reopened from Discovery rather than on first run. */
type OnboardingParams = { editing?: boolean } | undefined;

export type RootStackParamList = {
  OnboardingGroup: OnboardingParams;
  OnboardingInterests: OnboardingParams;
  OnboardingTime: OnboardingParams;
  Discovery: undefined;
  TourDetail: { tourId: string; title: string };
  ActiveTour: { tourId: string };
};

export type OnboardingGroupScreenProps = NativeStackScreenProps<RootStackParamList, 'OnboardingGroup'>;
export type OnboardingInterestsScreenProps = NativeStackScreenProps<RootStackParamList, 'OnboardingInterests'>;
export type OnboardingTimeScreenProps = NativeStackScreenProps<RootStackParamList, 'OnboardingTime'>;
export type DiscoveryScreenProps = NativeStackScreenProps<RootStackParamList, 'Discovery'>;
export type TourDetailScreenProps = NativeStackScreenProps<RootStackParamList, 'TourDetail'>;
export type ActiveTourScreenProps = NativeStackScreenProps<RootStackParamList, 'ActiveTour'>;

/** Makes useNavigation() typed app-wide without a cast at each call site. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
