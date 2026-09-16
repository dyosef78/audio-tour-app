export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.17"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_admins: {
        Row: {
          email: string | null
          granted_at: string
          granted_by: string | null
          note: string | null
          user_id: string
        }
        Insert: {
          email?: string | null
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id: string
        }
        Update: {
          email?: string | null
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id?: string
        }
        Relationships: []
      }
      audio_tracks: {
        Row: {
          created_at: string
          duration_seconds: number | null
          format: string | null
          id: string
          lufs_normalization: number | null
          size_bytes: number
          storage_path: string
          track_kind: string
          updated_at: string
          waypoint_id: string
        }
        Insert: {
          created_at?: string
          duration_seconds?: number | null
          format?: string | null
          id?: string
          lufs_normalization?: number | null
          size_bytes: number
          storage_path: string
          track_kind?: string
          updated_at?: string
          waypoint_id: string
        }
        Update: {
          created_at?: string
          duration_seconds?: number | null
          format?: string | null
          id?: string
          lufs_normalization?: number | null
          size_bytes?: number
          storage_path?: string
          track_kind?: string
          updated_at?: string
          waypoint_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audio_tracks_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      geofence_zones: {
        Row: {
          created_at: string
          geom: unknown
          id: string
          trigger_radius_meters: number | null
          updated_at: string
          waypoint_id: string
          zone_type: string
        }
        Insert: {
          created_at?: string
          geom: unknown
          id?: string
          trigger_radius_meters?: number | null
          updated_at?: string
          waypoint_id: string
          zone_type: string
        }
        Update: {
          created_at?: string
          geom?: unknown
          id?: string
          trigger_radius_meters?: number | null
          updated_at?: string
          waypoint_id?: string
          zone_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "geofence_zones_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      route_legs_cache: {
        Row: {
          coords_key: string
          distance_meters: number
          duration_seconds: number
          end_poi_id: string
          polyline: string
          profile: string
          start_poi_id: string
          updated_at: string
        }
        Insert: {
          coords_key: string
          distance_meters: number
          duration_seconds: number
          end_poi_id: string
          polyline: string
          profile: string
          start_poi_id: string
          updated_at?: string
        }
        Update: {
          coords_key?: string
          distance_meters?: number
          duration_seconds?: number
          end_poi_id?: string
          polyline?: string
          profile?: string
          start_poi_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_legs_cache_end_poi_id_fkey"
            columns: ["end_poi_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "route_legs_cache_start_poi_id_fkey"
            columns: ["start_poi_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      telemetry_events: {
        Row: {
          app_version: string | null
          audio_track_id: string | null
          client_event_id: string
          device_id: string
          event_type: string
          id: number
          meta: Json | null
          occurred_at: string
          platform: string | null
          position_seconds: number | null
          received_at: string
          tour_id: string | null
          track_seconds: number | null
          waypoint_id: string | null
        }
        Insert: {
          app_version?: string | null
          audio_track_id?: string | null
          client_event_id: string
          device_id: string
          event_type: string
          id?: never
          meta?: Json | null
          occurred_at: string
          platform?: string | null
          position_seconds?: number | null
          received_at?: string
          tour_id?: string | null
          track_seconds?: number | null
          waypoint_id?: string | null
        }
        Update: {
          app_version?: string | null
          audio_track_id?: string | null
          client_event_id?: string
          device_id?: string
          event_type?: string
          id?: never
          meta?: Json | null
          occurred_at?: string
          platform?: string | null
          position_seconds?: number | null
          received_at?: string
          tour_id?: string | null
          track_seconds?: number | null
          waypoint_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemetry_events_audio_track_id_fkey"
            columns: ["audio_track_id"]
            isOneToOne: false
            referencedRelation: "audio_tracks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_events_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_events_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      tours: {
        Row: {
          audiences: string[]
          created_at: string
          duration_minutes: number
          id: string
          interests: string[]
          route: unknown
          start_point: unknown
          status: string
          title: string
          topology: string
          transit_mode: string
          updated_at: string
        }
        Insert: {
          audiences?: string[]
          created_at?: string
          duration_minutes: number
          id?: string
          interests?: string[]
          route?: unknown
          start_point?: unknown
          status?: string
          title: string
          topology: string
          transit_mode: string
          updated_at?: string
        }
        Update: {
          audiences?: string[]
          created_at?: string
          duration_minutes?: number
          id?: string
          interests?: string[]
          route?: unknown
          start_point?: unknown
          status?: string
          title?: string
          topology?: string
          transit_mode?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_itineraries: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          notes: string | null
          planned_for: string | null
          title: string | null
          tour_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          planned_for?: string | null
          title?: string | null
          tour_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          planned_for?: string | null
          title?: string | null
          tour_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_itineraries_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
      user_itinerary_waypoints: {
        Row: {
          included: boolean
          itinerary_id: string
          sort_order: number | null
          updated_at: string
          waypoint_id: string
        }
        Insert: {
          included?: boolean
          itinerary_id: string
          sort_order?: number | null
          updated_at?: string
          waypoint_id: string
        }
        Update: {
          included?: boolean
          itinerary_id?: string
          sort_order?: number | null
          updated_at?: string
          waypoint_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_itinerary_waypoints_itinerary_id_fkey"
            columns: ["itinerary_id"]
            isOneToOne: false
            referencedRelation: "user_itineraries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_itinerary_waypoints_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      waypoints: {
        Row: {
          audiences: string[]
          created_at: string
          geom: unknown
          id: string
          interests: string[]
          name: string
          poi_type: string
          sort_order: number
          tour_id: string
          updated_at: string
        }
        Insert: {
          audiences?: string[]
          created_at?: string
          geom: unknown
          id?: string
          interests?: string[]
          name: string
          poi_type: string
          sort_order: number
          tour_id: string
          updated_at?: string
        }
        Update: {
          audiences?: string[]
          created_at?: string
          geom?: unknown
          id?: string
          interests?: string[]
          name?: string
          poi_type?: string
          sort_order?: number
          tour_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waypoints_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_kpi_audio_completion: {
        Row: {
          completion_rate: number | null
          devices_completed: number | null
          devices_skipped: number | null
          devices_started: number | null
          skip_rate: number | null
          sort_order: number | null
          tour_id: string | null
          tour_title: string | null
          waypoint_id: string | null
          waypoint_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemetry_events_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_events_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      v_kpi_audio_dropoff: {
        Row: {
          abandoned_early: number | null
          avg_progress_at_stop: number | null
          median_progress_at_stop: number | null
          stop_events: number | null
          tour_id: string | null
          tour_title: string | null
          waypoint_id: string | null
          waypoint_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemetry_events_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_events_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
      v_kpi_deep_dive_completion: {
        Row: {
          avg_progress_at_stop: number | null
          completion_rate: number | null
          devices_completed: number | null
          devices_started: number | null
          sort_order: number | null
          tour_id: string | null
          tour_title: string | null
          waypoint_id: string | null
          waypoint_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telemetry_events_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telemetry_events_waypoint_id_fkey"
            columns: ["waypoint_id"]
            isOneToOne: false
            referencedRelation: "waypoints"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      assert_cms_admin: { Args: never; Returns: undefined }
      audience_tag_vocabulary: { Args: never; Returns: string[] }
      audio_object_is_published: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      cms_normalise_tags: {
        Args: { p_label: string; p_tags: string[]; p_vocabulary: string[] }
        Returns: string[]
      }
      cms_publish_tour: {
        Args: { p_tour_id: string }
        Returns: {
          audiences: string[]
          created_at: string
          duration_minutes: number
          id: string
          interests: string[]
          route: unknown
          start_point: unknown
          status: string
          title: string
          topology: string
          transit_mode: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tours"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cms_register_audio_track: {
        Args: {
          p_duration_seconds: number
          p_lufs_normalization?: number
          p_size_bytes: number
          p_storage_path: string
          p_track_kind?: string
          p_waypoint_id: string
        }
        Returns: Json
      }
      cms_replace_tour_waypoints: {
        Args: { p_tour_id: string; p_waypoints: Json }
        Returns: Json
      }
      cms_set_tour_route: {
        Args: { p_polyline: string; p_precision: number; p_tour_id: string }
        Returns: Json
      }
      cms_set_tour_status: {
        Args: { p_status: string; p_tour_id: string }
        Returns: {
          audiences: string[]
          created_at: string
          duration_minutes: number
          id: string
          interests: string[]
          route: unknown
          start_point: unknown
          status: string
          title: string
          topology: string
          transit_mode: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tours"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cms_upsert_tour: {
        Args: {
          p_audiences?: string[]
          p_duration_minutes: number
          p_interests?: string[]
          p_title: string
          p_topology: string
          p_tour_id: string
          p_transit_mode: string
        }
        Returns: {
          audiences: string[]
          created_at: string
          duration_minutes: number
          id: string
          interests: string[]
          route: unknown
          start_point: unknown
          status: string
          title: string
          topology: string
          transit_mode: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "tours"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cms_validate_tour: {
        Args: { p_tour_id: string }
        Returns: {
          code: string
          detail: string
          severity: string
          waypoint_id: string
        }[]
      }
      get_tour_bundle: { Args: { p_tour_id: string }; Returns: Json }
      interest_tag_vocabulary: { Args: never; Returns: string[] }
      is_cms_admin: { Args: never; Returns: boolean }
      route_tolerance_meters: {
        Args: { p_transit_mode: string }
        Returns: number
      }
      sync_pull_itineraries: { Args: { p_since?: string }; Returns: Json }
      tour_is_published: { Args: { p_tour_id: string }; Returns: boolean }
      transcript_path_for: { Args: { p_storage_path: string }; Returns: string }
      waypoint_is_published: {
        Args: { p_waypoint_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
