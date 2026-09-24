use crate::{
    server::ApiError,
    settings::{ImageCompression, WebPreferences},
};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

pub(super) struct Processed {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
    pub warning: Option<String>,
}

fn animated(bytes: &[u8], format: ImageFormat) -> Result<bool, ApiError> {
    if format == ImageFormat::Gif {
        return Ok(true);
    }
    if format == ImageFormat::WebP {
        return Ok(
            bytes.get(12..16) == Some(b"VP8X") && bytes.get(20).is_some_and(|flags| flags & 2 != 0)
        );
    }
    if format == ImageFormat::Png {
        let mut offset = 8;
        while offset + 12 <= bytes.len() {
            let length = u32::from_be_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| ApiError::bad_request("Invalid PNG chunk."))?,
            ) as usize;
            if bytes.get(offset + 4..offset + 8) == Some(b"acTL") {
                return Ok(true);
            }
            offset = offset
                .checked_add(length + 12)
                .ok_or_else(|| ApiError::bad_request("Invalid PNG chunk size."))?;
            if offset > bytes.len() {
                return Err(ApiError::bad_request("The PNG data is truncated."));
            }
        }
    }
    Ok(false)
}

pub(super) fn process(
    bytes: &[u8],
    mime: &str,
    settings: &WebPreferences,
) -> Result<Processed, ApiError> {
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err(ApiError::too_large("Images must contain 1 byte to 16 MiB."));
    }
    let format = image::guess_format(bytes)
        .map_err(|_| ApiError::bad_request("The file is not a supported image."))?;
    let (extension, expected) = match format {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::Gif => ("gif", "image/gif"),
        ImageFormat::WebP => ("webp", "image/webp"),
        _ => {
            return Err(ApiError::bad_request(
                "Use a PNG, JPEG, GIF, or WebP image.",
            ));
        }
    };
    if mime != expected {
        return Err(ApiError::bad_request(
            "The image type does not match its contents.",
        ));
    }
    let preserve_animation = animated(bytes, format)?;
    let requested =
        settings.image_compression != ImageCompression::Original || settings.image_max_edge > 0;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| ApiError::bad_request("The image is damaged or too large."))?;
    let (width, height) = decoder.dimensions();
    let needs_resize = settings.image_max_edge > 0 && width.max(height) > settings.image_max_edge;
    let transform = !preserve_animation
        && (settings.image_compression != ImageCompression::Original || needs_resize);
    let orientation = if transform {
        Some(decoder.orientation().map_err(|_| {
            ApiError::bad_request("The image orientation could not be read safely.")
        })?)
    } else {
        None
    };
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| {
        ApiError::bad_request("The image is damaged or exceeds the image memory limit.")
    })?;
    if !transform {
        return Ok(Processed {
            bytes: bytes.to_vec(),
            extension,
            warning: (preserve_animation && requested)
                .then(|| "Animated images are kept unchanged.".into()),
        });
    }
    if let Some(orientation) = orientation {
        image.apply_orientation(orientation);
    }
    let resized =
        settings.image_max_edge > 0 && image.width().max(image.height()) > settings.image_max_edge;
    if resized {
        image = image.resize(
            settings.image_max_edge,
            settings.image_max_edge,
            image::imageops::FilterType::Triangle,
        );
    }
    let mut output = Vec::new();
    let extension = match settings.image_compression {
        ImageCompression::Webp => {
            let image = image.into_rgba8();
            image::codecs::webp::WebPEncoder::new_lossless(&mut output)
                .write_image(
                    image.as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|error| {
                    ApiError::internal(format!("Could not compress the image: {error}"))
                })?;
            "webp"
        }
        ImageCompression::Jpeg => {
            let rgba = image.into_rgba8();
            let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
            for (source, target) in rgba.pixels().zip(rgb.pixels_mut()) {
                let alpha = source[3] as u16;
                for channel in 0..3 {
                    target[channel] =
                        ((source[channel] as u16 * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
                }
            }
            drop(rgba);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, settings.image_quality)
                .encode_image(&rgb)
                .map_err(|error| {
                    ApiError::internal(format!("Could not compress the image: {error}"))
                })?;
            "jpg"
        }
        ImageCompression::Original => {
            if format == ImageFormat::Jpeg {
                image::codecs::jpeg::JpegEncoder::new_with_quality(
                    &mut output,
                    settings.image_quality,
                )
                .encode_image(&image)
                .map_err(|error| {
                    ApiError::internal(format!("Could not resize the image: {error}"))
                })?;
            } else {
                image
                    .write_to(&mut Cursor::new(&mut output), format)
                    .map_err(|error| {
                        ApiError::internal(format!("Could not resize the image: {error}"))
                    })?;
            }
            extension
        }
    };
    if !resized && output.len() >= bytes.len() {
        return Ok(Processed {
            bytes: bytes.to_vec(),
            extension: match format {
                ImageFormat::Png => "png",
                ImageFormat::Jpeg => "jpg",
                _ => "webp",
            },
            warning: Some("The original image was smaller, so it was kept unchanged.".into()),
        });
    }
    if output.len() > 16 * 1024 * 1024 {
        return Err(ApiError::too_large(
            "The processed image exceeds 16 MiB. Choose a smaller maximum size or lower quality.",
        ));
    }
    Ok(Processed {
        bytes: output,
        extension,
        warning: None,
    })
}
