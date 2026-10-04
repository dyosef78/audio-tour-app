-- =============================================================================
-- Epic 16 Part 5: cities.center_lon / center_lat
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- The places-search proxy biases Google autocomplete to the city the visitor
-- is planning in, and the app will centre its planning map on it. Both need
-- the centre as two numbers. PostgREST returns a geography column as hex
-- EWKB, and decoding that by hand in TypeScript would be a second formatter
-- for the same fact - so the database states it once, as STORED generated
-- columns that cannot drift from `center`.
--
-- WHAT THIS DOES TO EXISTING DATA: adds two columns computed from `center`
-- for every existing row (one table rewrite of a handful of rows). No policy
-- changes: anon already reads cities through cities_read_with_published_tour.
-- Bundle hashes are untouched (get_tour_bundle does not read cities).
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE public.cities
    ADD COLUMN IF NOT EXISTS center_lon double precision
        GENERATED ALWAYS AS (ST_X(center::geometry)) STORED,
    ADD COLUMN IF NOT EXISTS center_lat double precision
        GENERATED ALWAYS AS (ST_Y(center::geometry)) STORED;

COMMENT ON COLUMN public.cities.center_lon IS
    'Generated from center (WGS84 longitude). For clients that cannot decode a geography: the places-search bias, the planning map.';
COMMENT ON COLUMN public.cities.center_lat IS
    'Generated from center (WGS84 latitude).';
