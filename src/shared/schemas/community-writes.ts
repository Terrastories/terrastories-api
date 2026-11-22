import { z } from 'zod';
import {
  DESCRIPTION_MAX_RAW_LENGTH,
  InvalidDescriptionError,
  validateDescriptionForWrite,
} from '../utils/safe-description.js';
import {
  CommunityMapConfigSchema,
  CommunityReadDetailResponseSchema,
  CommunityReadVisibilitySchema,
} from './community-reads.js';
import { V2ErrorResponseSchema } from './public-communities.js';
import {
  MAPBOX_ACCESS_TOKEN_MAX_LENGTH,
  MAPBOX_STYLE_URL_MAX_LENGTH,
  PROTOMAPS_API_KEY_MAX_LENGTH,
  PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH,
  isPublicMapboxToken,
  isValidProtomapsApiKey,
  sanitizeMapboxStyleUrl,
} from '../utils/map-config.js';
import {
  PublicPlaceDetailResponseSchema,
  PublicSpeakerDetailResponseSchema,
  type PublicPlaceDetailResponse,
  type PublicSpeakerDetailResponse,
} from './public-content.js';
import { MAX_DATABASE_ID } from '../types/public.js';

export const V2ValidationFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type V2ValidationFieldError = z.infer<
  typeof V2ValidationFieldErrorSchema
>;

export const V2ValidationErrorResponseSchema = V2ErrorResponseSchema.extend({
  details: z
    .object({
      fields: z.array(V2ValidationFieldErrorSchema),
    })
    .optional(),
});

export type V2ValidationErrorResponse = z.infer<
  typeof V2ValidationErrorResponseSchema
>;

export function makeValidationErrorBody(
  fields: V2ValidationFieldError[],
  message = 'Validation failed',
  code = 'validation_error'
): V2ValidationErrorResponse {
  return {
    error: message,
    code,
    details: { fields },
  };
}

export function zodErrorToValidationFields(
  error: z.ZodError
): V2ValidationFieldError[] {
  const fields: V2ValidationFieldError[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) {
      const prefix = issue.path.length > 0 ? `${issue.path.join('.')}.` : '';
      for (const key of issue.keys) {
        fields.push({
          path: `${prefix}${key}`,
          message: 'Unrecognized field',
        });
      }
      continue;
    }
    fields.push({
      path: issue.path.length > 0 ? issue.path.join('.') : 'body',
      message: issue.message,
    });
  }
  return fields;
}

/**
 * Validate rich-text description input for write endpoints without ever echoing
 * user-supplied description content in validation error messages.
 */
export function addDescriptionValidationIssues(
  value: string | null | undefined,
  path: string,
  ctx: z.RefinementCtx
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (value.length > DESCRIPTION_MAX_RAW_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `Description raw input exceeds maximum size of ${DESCRIPTION_MAX_RAW_LENGTH} characters`,
    });
    return;
  }
  if (value.trim().length === 0) {
    return;
  }
  try {
    validateDescriptionForWrite(value);
  } catch (err) {
    if (err instanceof InvalidDescriptionError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: err.message,
      });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: 'Description failed validation',
    });
  }
}

const LocaleSchema = z
  .string()
  .trim()
  .min(1, 'Locale must not be empty')
  .max(35, 'Locale must be at most 35 characters')
  .regex(/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/, 'Invalid locale format');

export const NullableTrimmedText = (fieldLabel: string, maxLength: number) =>
  z.union([
    z
      .string()
      .trim()
      .max(maxLength, `${fieldLabel} must be at most ${maxLength} characters`)
      .transform((v) => (v.length === 0 ? null : v)),
    z.null(),
  ]);

export const makeDatabaseIdSchema = (fieldLabel: string) =>
  z
    .number()
    .int(`${fieldLabel} must be an integer`)
    .min(1, `${fieldLabel} must be a positive integer`)
    .max(MAX_DATABASE_ID, `${fieldLabel} must be at most ${MAX_DATABASE_ID}`);

export const PatchCommunityRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name must not be empty')
      .max(255, 'Name must be at most 255 characters')
      .optional(),
    description: z.union([z.string(), z.null()]).optional(),
    locale: LocaleSchema.optional(),
    country: NullableTrimmedText('Country', 120).optional(),
    visibility: CommunityReadVisibilitySchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be provided',
      });
    }
    addDescriptionValidationIssues(data.description, 'description', ctx);
  });

export type PatchCommunityRequest = z.infer<typeof PatchCommunityRequestSchema>;

const NullableLatitudeSchema = z
  .number()
  .finite('Latitude must be a finite number')
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90')
  .transform((v) => (Object.is(v, -0) ? 0 : v))
  .nullable();

const NullableLongitudeSchema = z
  .number()
  .finite('Longitude must be a finite number')
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180')
  .transform((v) => (Object.is(v, -0) ? 0 : v))
  .nullable();

export const PutCommunityMapConfigRequestSchema = z
  .object({
    styleUrl: z
      .union([
        z
          .string()
          .trim()
          .max(2048, 'Style URL must be at most 2048 characters'),
        z.null(),
      ])
      .default(null),
    basemapStyle: NullableTrimmedText('Basemap style', 120).default(null),
    mapboxStyleUrl: NullableTrimmedText(
      'Mapbox style URL',
      MAPBOX_STYLE_URL_MAX_LENGTH
    ).default(null),
    mapboxAccessToken: NullableTrimmedText(
      'Mapbox access token',
      MAPBOX_ACCESS_TOKEN_MAX_LENGTH
    ).default(null),
    exposeMapboxCredentials: z.boolean().default(false),
    mapbox3d: z.boolean().default(false),
    protomapsApiKey: NullableTrimmedText(
      'Protomaps API key',
      PROTOMAPS_API_KEY_MAX_LENGTH
    ).default(null),
    protomapsBasemapStyle: NullableTrimmedText(
      'Protomaps basemap style',
      PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH
    ).default(null),
    centerLatitude: NullableLatitudeSchema.default(null),
    centerLongitude: NullableLongitudeSchema.default(null),
    southWestLatitude: NullableLatitudeSchema.default(null),
    southWestLongitude: NullableLongitudeSchema.default(null),
    northEastLatitude: NullableLatitudeSchema.default(null),
    northEastLongitude: NullableLongitudeSchema.default(null),
    zoom: z
      .number()
      .finite('Zoom must be a finite number')
      .min(0, 'Zoom must be between 0 and 24')
      .max(24, 'Zoom must be between 0 and 24')
      .transform((v) => (Object.is(v, -0) ? 0 : v))
      .nullable()
      .default(null),
    pitch: z
      .number()
      .finite('Pitch must be a finite number')
      .min(0, 'Pitch must be between 0 and 90')
      .max(90, 'Pitch must be between 0 and 90')
      .transform((v) => (Object.is(v, -0) ? 0 : v))
      .nullable()
      .default(null),
    bearing: z
      .number()
      .finite('Bearing must be a finite number')
      .min(-360, 'Bearing must be between -360 and 360')
      .max(360, 'Bearing must be between -360 and 360')
      .transform((v) => (Object.is(v, -0) ? 0 : v))
      .nullable()
      .default(null),
    threeDimensional: z.boolean().nullable().default(null),
    projection: NullableTrimmedText('Projection', 64).default(null),
    staticMapFileId: z
      .string()
      .uuid('staticMapFileId must be a valid UUID')
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasMapboxStyle = data.mapboxStyleUrl !== null;
    const hasMapboxToken = data.mapboxAccessToken !== null;
    if (hasMapboxStyle !== hasMapboxToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasMapboxStyle ? 'mapboxAccessToken' : 'mapboxStyleUrl'],
        message:
          'Mapbox style URL and Mapbox access token must both be provided or both be blank',
      });
    }
    if (
      data.mapboxStyleUrl !== null &&
      sanitizeMapboxStyleUrl(data.mapboxStyleUrl) === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mapboxStyleUrl'],
        message:
          'Mapbox style URL must be a valid mapbox://styles/... URI or credential-free https URL',
      });
    }
    if (
      data.mapboxAccessToken !== null &&
      !isPublicMapboxToken(data.mapboxAccessToken)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mapboxAccessToken'],
        message: 'Mapbox access token must be a valid public token (pk.*)',
      });
    }
    if (
      data.protomapsApiKey !== null &&
      !isValidProtomapsApiKey(data.protomapsApiKey)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protomapsApiKey'],
        message: 'Protomaps API key must not contain whitespace',
      });
    }

    const centerHasLat = data.centerLatitude !== null;
    const centerHasLng = data.centerLongitude !== null;
    if (centerHasLat !== centerHasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [centerHasLat ? 'centerLongitude' : 'centerLatitude'],
        message: 'Center latitude and longitude must be provided together',
      });
    }

    const swHasLat = data.southWestLatitude !== null;
    const swHasLng = data.southWestLongitude !== null;
    if (swHasLat !== swHasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [swHasLat ? 'southWestLongitude' : 'southWestLatitude'],
        message: 'Southwest latitude and longitude must be provided together',
      });
    }

    const neHasLat = data.northEastLatitude !== null;
    const neHasLng = data.northEastLongitude !== null;
    if (neHasLat !== neHasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [neHasLat ? 'northEastLongitude' : 'northEastLatitude'],
        message: 'Northeast latitude and longitude must be provided together',
      });
    }

    const hasSw = swHasLat || swHasLng;
    const hasNe = neHasLat || neHasLng;
    if (hasSw !== hasNe) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasSw ? 'northEastLatitude' : 'southWestLatitude'],
        message:
          'Both southwest and northeast map bounds must be provided together',
      });
    }

    if (
      data.southWestLatitude !== null &&
      data.northEastLatitude !== null &&
      data.southWestLatitude > data.northEastLatitude
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['southWestLatitude'],
        message:
          'Southwest latitude must be less than or equal to northeast latitude',
      });
    }
  });

export type PutCommunityMapConfigRequest = z.infer<
  typeof PutCommunityMapConfigRequestSchema
>;

export const PatchCommunityResponseSchema = CommunityReadDetailResponseSchema;
export type PatchCommunityResponse = z.infer<
  typeof PatchCommunityResponseSchema
>;

export const PutCommunityMapConfigResponseSchema = z.object({
  data: CommunityMapConfigSchema,
});
export type PutCommunityMapConfigResponse = z.infer<
  typeof PutCommunityMapConfigResponseSchema
>;

function addNullableCoordinatePairValidationIssues(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
  requireBothKeysWhenPresent: boolean,
  ctx: z.RefinementCtx
): void {
  const hasLatKey = latitude !== undefined;
  const hasLngKey = longitude !== undefined;
  if (requireBothKeysWhenPresent && hasLatKey !== hasLngKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLatKey ? 'longitude' : 'latitude'],
      message: 'Latitude and longitude must be provided together',
    });
    return;
  }

  const latVal = latitude ?? null;
  const lngVal = longitude ?? null;
  if ((latVal !== null) !== (lngVal !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [latVal !== null ? 'longitude' : 'latitude'],
      message: 'Latitude and longitude must both be numbers or both be null',
    });
  }
}

export const CreatePlaceRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name must not be empty')
      .max(200, 'Name must be at most 200 characters'),
    description: z.union([z.string(), z.null()]).optional(),
    typeOfPlace: NullableTrimmedText('Type of place', 120).optional(),
    region: NullableTrimmedText('Region', 120).optional(),
    latitude: NullableLatitudeSchema.optional(),
    longitude: NullableLongitudeSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    addDescriptionValidationIssues(data.description, 'description', ctx);
    addNullableCoordinatePairValidationIssues(
      data.latitude,
      data.longitude,
      false,
      ctx
    );
  });

export type CreatePlaceRequest = z.infer<typeof CreatePlaceRequestSchema>;

export const PatchPlaceRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name must not be empty')
      .max(200, 'Name must be at most 200 characters')
      .optional(),
    description: z.union([z.string(), z.null()]).optional(),
    typeOfPlace: NullableTrimmedText('Type of place', 120).optional(),
    region: NullableTrimmedText('Region', 120).optional(),
    latitude: NullableLatitudeSchema.optional(),
    longitude: NullableLongitudeSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be provided',
      });
    }
    addDescriptionValidationIssues(data.description, 'description', ctx);
    addNullableCoordinatePairValidationIssues(
      data.latitude,
      data.longitude,
      true,
      ctx
    );
  });

export type PatchPlaceRequest = z.infer<typeof PatchPlaceRequestSchema>;

export const PlaceWriteResponseSchema = PublicPlaceDetailResponseSchema;
export type PlaceWriteResponse = PublicPlaceDetailResponse;

export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

const NullableCalendarDateSchema = z.union([
  z.string().trim().refine(isValidCalendarDate, {
    message: 'Birth date must be a valid YYYY-MM-DD calendar date',
  }),
  z.null(),
]);

const NullableBirthplaceIdSchema = z.union([
  z
    .number()
    .int('birthplaceId must be an integer')
    .min(1, 'birthplaceId must be a positive integer')
    .max(MAX_DATABASE_ID, `birthplaceId must be at most ${MAX_DATABASE_ID}`),
  z.null(),
]);

export const CreateSpeakerRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name must not be empty')
      .max(200, 'Name must be at most 200 characters'),
    birthDate: NullableCalendarDateSchema.optional(),
    birthplaceId: NullableBirthplaceIdSchema.optional(),
    affiliation: NullableTrimmedText('Affiliation', 200).optional(),
  })
  .strict();

export type CreateSpeakerRequest = z.infer<typeof CreateSpeakerRequestSchema>;

export const PatchSpeakerRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name must not be empty')
      .max(200, 'Name must be at most 200 characters')
      .optional(),
    birthDate: NullableCalendarDateSchema.optional(),
    birthplaceId: NullableBirthplaceIdSchema.optional(),
    affiliation: NullableTrimmedText('Affiliation', 200).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'At least one field must be provided',
      });
    }
  });

export type PatchSpeakerRequest = z.infer<typeof PatchSpeakerRequestSchema>;

export const SpeakerWriteResponseSchema = PublicSpeakerDetailResponseSchema;
export type SpeakerWriteResponse = PublicSpeakerDetailResponse;
