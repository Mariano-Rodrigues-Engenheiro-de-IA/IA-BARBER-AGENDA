
-- Create storage bucket for tenant media files
INSERT INTO storage.buckets (id, name, public) VALUES ('tenant-media', 'tenant-media', true);

-- Allow authenticated users to upload files
CREATE POLICY "Authenticated users can upload tenant media"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'tenant-media');

-- Allow public read access
CREATE POLICY "Public read access for tenant media"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'tenant-media');

-- Allow authenticated users to delete their uploads
CREATE POLICY "Authenticated users can delete tenant media"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'tenant-media');
