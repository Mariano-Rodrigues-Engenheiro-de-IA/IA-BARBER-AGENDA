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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_logs: {
        Row: {
          ai_response: string | null
          created_at: string
          duration_ms: number | null
          errors: Json | null
          id: string
          model_used: string | null
          phone_number: string
          session_blocked: boolean | null
          tenant_id: string
          tool_calls: Json | null
          total_tokens: number | null
          user_message: string
        }
        Insert: {
          ai_response?: string | null
          created_at?: string
          duration_ms?: number | null
          errors?: Json | null
          id?: string
          model_used?: string | null
          phone_number: string
          session_blocked?: boolean | null
          tenant_id: string
          tool_calls?: Json | null
          total_tokens?: number | null
          user_message: string
        }
        Update: {
          ai_response?: string | null
          created_at?: string
          duration_ms?: number | null
          errors?: Json | null
          id?: string
          model_used?: string | null
          phone_number?: string
          session_blocked?: boolean | null
          tenant_id?: string
          tool_calls?: Json | null
          total_tokens?: number | null
          user_message?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_prompt_versions: {
        Row: {
          change_summary: string | null
          created_at: string
          created_by: string | null
          created_by_role: string | null
          id: string
          prompt: string
          tenant_id: string
          version: number
        }
        Insert: {
          change_summary?: string | null
          created_at?: string
          created_by?: string | null
          created_by_role?: string | null
          id?: string
          prompt: string
          tenant_id: string
          version: number
        }
        Update: {
          change_summary?: string | null
          created_at?: string
          created_by?: string | null
          created_by_role?: string | null
          id?: string
          prompt?: string
          tenant_id?: string
          version?: number
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_role: string | null
          after: Json | null
          before: Json | null
          created_at: string
          entity: string
          entity_id: string | null
          id: string
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          actor_role?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      celcash_subscribers: {
        Row: {
          celcash_customer_id: string
          celcash_subscription_id: string | null
          created_at: string
          document: string | null
          email: string | null
          id: string
          is_overdue: boolean
          last_payment_date: string | null
          name: string | null
          next_due_date: string | null
          overdue_amount_cents: number
          phone_e164: string | null
          phone_raw: string | null
          plan_id: string | null
          plan_name: string | null
          raw_payload: Json
          status: string
          synced_at: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          celcash_customer_id: string
          celcash_subscription_id?: string | null
          created_at?: string
          document?: string | null
          email?: string | null
          id?: string
          is_overdue?: boolean
          last_payment_date?: string | null
          name?: string | null
          next_due_date?: string | null
          overdue_amount_cents?: number
          phone_e164?: string | null
          phone_raw?: string | null
          plan_id?: string | null
          plan_name?: string | null
          raw_payload?: Json
          status?: string
          synced_at?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          celcash_customer_id?: string
          celcash_subscription_id?: string | null
          created_at?: string
          document?: string | null
          email?: string | null
          id?: string
          is_overdue?: boolean
          last_payment_date?: string | null
          name?: string | null
          next_due_date?: string | null
          overdue_amount_cents?: number
          phone_e164?: string | null
          phone_raw?: string | null
          plan_id?: string | null
          plan_name?: string | null
          raw_payload?: Json
          status?: string
          synced_at?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "celcash_subscribers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      celcash_sync_runs: {
        Row: {
          created_at: string
          error_message: string | null
          finished_at: string | null
          id: string
          started_at: string
          status: string
          tenant_id: string
          total_fetched: number
          total_marked_canceled: number
          total_upserted: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          tenant_id: string
          total_fetched?: number
          total_marked_canceled?: number
          total_upserted?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          tenant_id?: string
          total_fetched?: number
          total_marked_canceled?: number
          total_upserted?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "celcash_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          message_id: string | null
          phone_number: string
          processed: boolean
          role: string
          tenant_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          message_id?: string | null
          phone_number: string
          processed?: boolean
          role: string
          tenant_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          message_id?: string | null
          phone_number?: string
          processed?: boolean
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_pauses: {
        Row: {
          created_at: string
          id: string
          paused: boolean
          phone_number: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          paused?: boolean
          phone_number: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          paused?: boolean
          phone_number?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_pauses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_state: {
        Row: {
          created_at: string
          id: string
          pending_bookings: Json | null
          phone_number: string
          state: Json
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          pending_bookings?: Json | null
          phone_number: string
          state?: Json
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          pending_bookings?: Json | null
          phone_number?: string
          state?: Json
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      crm_boards: {
        Row: {
          columns: Json
          created_at: string
          id: string
          name: string
          order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          columns?: Json
          created_at?: string
          id?: string
          name: string
          order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          columns?: Json
          created_at?: string
          id?: string
          name?: string
          order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      crm_lead_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          from_label: string | null
          id: string
          lead_id: string
          to_label: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          from_label?: string | null
          id?: string
          lead_id: string
          to_label: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          from_label?: string | null
          id?: string
          lead_id?: string
          to_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_lead_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "crm_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_leads: {
        Row: {
          ai_summary: string
          ai_summary_updated_at: string | null
          board_id: string | null
          created_at: string
          flag_labels: string[]
          id: string
          label_id: string
          label_name: string | null
          name: string | null
          notes: string | null
          phone_number: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ai_summary?: string
          ai_summary_updated_at?: string | null
          board_id?: string | null
          created_at?: string
          flag_labels?: string[]
          id?: string
          label_id: string
          label_name?: string | null
          name?: string | null
          notes?: string | null
          phone_number: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          ai_summary?: string
          ai_summary_updated_at?: string | null
          board_id?: string | null
          created_at?: string
          flag_labels?: string[]
          id?: string
          label_id?: string
          label_name?: string | null
          name?: string | null
          notes?: string | null
          phone_number?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      follow_up_sequences: {
        Row: {
          business_hours: Json
          created_at: string
          enabled: boolean
          id: string
          name: string
          tenant_id: string
          trigger_config: Json
          trigger_type: string
          updated_at: string
        }
        Insert: {
          business_hours?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          name: string
          tenant_id: string
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
        }
        Update: {
          business_hours?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          name?: string
          tenant_id?: string
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      follow_up_steps: {
        Row: {
          created_at: string
          delay_minutes: number
          id: string
          message: string
          sequence_id: string
          step_order: number
        }
        Insert: {
          created_at?: string
          delay_minutes?: number
          id?: string
          message: string
          sequence_id: string
          step_order: number
        }
        Update: {
          created_at?: string
          delay_minutes?: number
          id?: string
          message?: string
          sequence_id?: string
          step_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "follow_up_sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          follow_up_at: string
          follow_up_message: string | null
          id: string
          link_sent_at: string
          matched_keyword: string | null
          phone_number: string
          sent_at: string | null
          sequence_id: string | null
          status: string
          step_order: number | null
          tenant_id: string
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          follow_up_at: string
          follow_up_message?: string | null
          id?: string
          link_sent_at?: string
          matched_keyword?: string | null
          phone_number: string
          sent_at?: string | null
          sequence_id?: string | null
          status?: string
          step_order?: number | null
          tenant_id: string
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          follow_up_at?: string
          follow_up_message?: string | null
          id?: string
          link_sent_at?: string
          matched_keyword?: string | null
          phone_number?: string
          sent_at?: string | null
          sequence_id?: string | null
          status?: string
          step_order?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      onebeleza_client_aliases: {
        Row: {
          alias_phone: string
          burned_at: string | null
          created_at: string
          id: string
          real_name: string | null
          real_phone: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          alias_phone: string
          burned_at?: string | null
          created_at?: string
          id?: string
          real_name?: string | null
          real_phone: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          alias_phone?: string
          burned_at?: string | null
          created_at?: string
          id?: string
          real_name?: string | null
          real_phone?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_prompts: {
        Row: {
          content: string
          provider: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: string
          provider: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          provider?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      tenant_permissions: {
        Row: {
          created_at: string
          id: string
          module: string
          tenant_id: string
          updated_at: string
          visibility: string
        }
        Insert: {
          created_at?: string
          id?: string
          module: string
          tenant_id: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          created_at?: string
          id?: string
          module?: string
          tenant_id?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      tenant_users: {
        Row: {
          created_at: string
          id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          tenant_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: []
      }
      tenants: {
        Row: {
          address: string | null
          agent_knowledge_base: string | null
          agent_paused: boolean
          agent_settings: Json | null
          agent_system_prompt: string | null
          api_provider: Database["public"]["Enums"]["api_provider"]
          appbarber_api_key: string | null
          appbarber_base_url: string | null
          appbarber_establishment_code: string | null
          bemp_domain: string | null
          bemp_token: string | null
          booking_link: string | null
          celcash_enabled: boolean
          celcash_env: string
          celcash_galax_hash: string | null
          celcash_galax_id: string | null
          created_at: string
          email: string | null
          frizzar_base_url: string | null
          frizzar_token: string | null
          id: string
          kanban_columns: Json | null
          logo_url: string | null
          name: string
          onebeleza_celular: string | null
          onebeleza_token: string | null
          phone: string | null
          slug: string
          status: Database["public"]["Enums"]["tenant_status"]
          trinks_api_key: string | null
          trinks_establishment_id: string | null
          uazapi_token: string | null
          uazapi_url: string | null
          updated_at: string
          whatsapp_number: string | null
        }
        Insert: {
          address?: string | null
          agent_knowledge_base?: string | null
          agent_paused?: boolean
          agent_settings?: Json | null
          agent_system_prompt?: string | null
          api_provider?: Database["public"]["Enums"]["api_provider"]
          appbarber_api_key?: string | null
          appbarber_base_url?: string | null
          appbarber_establishment_code?: string | null
          bemp_domain?: string | null
          bemp_token?: string | null
          booking_link?: string | null
          celcash_enabled?: boolean
          celcash_env?: string
          celcash_galax_hash?: string | null
          celcash_galax_id?: string | null
          created_at?: string
          email?: string | null
          frizzar_base_url?: string | null
          frizzar_token?: string | null
          id?: string
          kanban_columns?: Json | null
          logo_url?: string | null
          name: string
          onebeleza_celular?: string | null
          onebeleza_token?: string | null
          phone?: string | null
          slug: string
          status?: Database["public"]["Enums"]["tenant_status"]
          trinks_api_key?: string | null
          trinks_establishment_id?: string | null
          uazapi_token?: string | null
          uazapi_url?: string | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Update: {
          address?: string | null
          agent_knowledge_base?: string | null
          agent_paused?: boolean
          agent_settings?: Json | null
          agent_system_prompt?: string | null
          api_provider?: Database["public"]["Enums"]["api_provider"]
          appbarber_api_key?: string | null
          appbarber_base_url?: string | null
          appbarber_establishment_code?: string | null
          bemp_domain?: string | null
          bemp_token?: string | null
          booking_link?: string | null
          celcash_enabled?: boolean
          celcash_env?: string
          celcash_galax_hash?: string | null
          celcash_galax_id?: string | null
          created_at?: string
          email?: string | null
          frizzar_base_url?: string | null
          frizzar_token?: string | null
          id?: string
          kanban_columns?: Json | null
          logo_url?: string | null
          name?: string
          onebeleza_celular?: string | null
          onebeleza_token?: string | null
          phone?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["tenant_status"]
          trinks_api_key?: string | null
          trinks_establishment_id?: string | null
          uazapi_token?: string | null
          uazapi_url?: string | null
          updated_at?: string
          whatsapp_number?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_edit_module: {
        Args: { _module: string; _tenant_id: string; _user_id: string }
        Returns: boolean
      }
      get_user_tenant_id: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      module_visibility: {
        Args: { _module: string; _tenant_id: string; _user_id: string }
        Returns: string
      }
    }
    Enums: {
      api_provider:
        | "trinks"
        | "onebeleza"
        | "frizzar"
        | "bemp"
        | "appbarber"
        | "none"
      app_role: "admin" | "client"
      tenant_status: "active" | "inactive" | "suspended"
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
  public: {
    Enums: {
      api_provider: [
        "trinks",
        "onebeleza",
        "frizzar",
        "bemp",
        "appbarber",
        "none",
      ],
      app_role: ["admin", "client"],
      tenant_status: ["active", "inactive", "suspended"],
    },
  },
} as const
