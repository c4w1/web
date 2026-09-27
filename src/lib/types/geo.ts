export type GeoMarkerProperties = {
  id: string;
  name: string;
  category: 'dataset' | 'site' | 'organization' | 'event' | 'other';
  tags?: string[];
  region?: string;
  sourceUrl?: string;
  description?: string;
  locationLabel?: string;
  updatedAt?: string; // ISO datetime
};

export type GeoMarkerFeature = {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  properties: GeoMarkerProperties;
};

export type GeoMarkerCollection = {
  type: 'FeatureCollection';
  features: GeoMarkerFeature[];
};
