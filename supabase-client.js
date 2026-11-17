import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const projectUrl = 'https://elegzmisbutmfbggswax.supabase.co';
const publishableKey = 'sb_publishable_O-2m5fJh8osuNMrv-zMEDw_xiQgyKCt';

export const supabase = createClient(projectUrl, publishableKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
  },
});
