"""Headroom's ready-made local compressor; no model download."""
def compress(context, query, **options):
    from headroom.transforms.text_crusher import TextCrusher, TextCrusherConfig
    return TextCrusher(TextCrusherConfig(target_ratio=0.7)).compress(context, context=query).compressed
