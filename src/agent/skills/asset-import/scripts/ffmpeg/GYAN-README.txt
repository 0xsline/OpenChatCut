FFmpeg 64-bit static Windows build from www.gyan.dev

Version: 8.1.2-essentials_build-www.gyan.dev

License: GPL v3

Source Code: https://github.com/FFmpeg/FFmpeg/commit/38b88335f9

release-essentials build configuration: 

ARCH                      x86 (generic)
big-endian                no
runtime cpu detection     yes
standalone assembly       yes
x86 assembler             nasm
MMX enabled               yes
MMXEXT enabled            yes
SSE enabled               yes
SSSE3 enabled             yes
AESNI enabled             yes
CLMUL enabled             yes
AVX enabled               yes
AVX2 enabled              yes
AVX-512 enabled           yes
AVX-512ICL enabled        yes
XOP enabled               yes
FMA3 enabled              yes
FMA4 enabled              yes
i686 features enabled     yes
CMOV is fast              yes
EBX available             yes
EBP available             yes
debug symbols             yes
strip symbols             yes
optimize for size         no
optimizations             yes
static                    yes
shared                    no
network support           yes
threading support         pthreads
safe bitstream reader     yes
texi2html enabled         no
perl enabled              yes
pod2man enabled           yes
makeinfo enabled          yes
makeinfo supports HTML    yes
experimental features     yes
xmllint enabled           yes

External libraries:
avisynth                libmp3lame              libvorbis
bzlib                   libopencore_amrnb       libvpx
cairo                   libopencore_amrwb       libwebp
gmp                     libopenjpeg             libx264
gnutls                  libopenmpt              libx265
iconv                   libopus                 libxml2
libaom                  librubberband           libxvid
libass                  libspeex                libzimg
libfontconfig           libsrt                  libzmq
libfreetype             libssh                  lzma
libfribidi              libtheora               mediafoundation
libgme                  libvidstab              openal
libgsm                  libvmaf                 sdl2
libharfbuzz             libvo_amrwbenc          zlib

External libraries providing hardware acceleration:
amf                     d3d12va                 nvdec
cuda                    dxva2                   nvenc
cuda_llvm               ffnvcodec               vaapi
cuvid                   libmfx
d3d11va                 libvpl

Libraries:
avcodec                 avformat                swscale
avdevice                avutil
avfilter                swresample

Programs:
ffmpeg                  ffplay                  ffprobe

Enabled decoders:
aac                     flashsv                 pdv
aac_fixed               flashsv2                pfm
aac_latm                flic                    pgm
aasc                    flv                     pgmyuv
ac3                     fmvc                    pgssub
ac3_fixed               fourxm                  pgx
acelp_kelvin            fraps                   phm
adpcm_4xm               frwu                    photocd
adpcm_adx               ftr                     pictor
adpcm_afc               g2m                     pixlet
adpcm_agm               g723_1                  pjs
adpcm_aica              g728                    png
adpcm_argo              g729                    ppm
adpcm_circus            gdv                     prores
adpcm_ct                gem                     prores_raw
adpcm_dtk               gif                     prosumer
adpcm_ea                gremlin_dpcm            psd
adpcm_ea_maxis_xa       gsm                     ptx
adpcm_ea_r1             gsm_ms                  qcelp
adpcm_ea_r2             h261                    qdm2
adpcm_ea_r3             h263                    qdmc
adpcm_ea_xas            h263i                   qdraw
adpcm_g722              h263p                   qoa
adpcm_g726              h264                    qoi
adpcm_g726le            h264_amf                qpeg
adpcm_ima_acorn         h264_cuvid              qtrle
adpcm_ima_alp           h264_qsv                r10k
adpcm_ima_amv           hap                     r210
adpcm_ima_apc           hca                     ra_144
adpcm_ima_apm           hcom                    ra_288
adpcm_ima_cunning       hdr                     ralf
adpcm_ima_dat4          hevc                    rasc
adpcm_ima_dk3           hevc_amf                rawvideo
adpcm_ima_dk4           hevc_cuvid              realtext
adpcm_ima_ea_eacs       hevc_qsv                rka
adpcm_ima_ea_sead       hnm4_video              rl2
adpcm_ima_escape        hq_hqa                  roq
adpcm_ima_hvqm2         hqx                     roq_dpcm
adpcm_ima_hvqm4         huffyuv                 rpza
adpcm_ima_iss           hymt                    rscc
adpcm_ima_magix         iac                     rtv1
adpcm_ima_moflex        idcin                   rv10
adpcm_ima_mtf           idf                     rv20
adpcm_ima_oki           iff_ilbm                rv30
adpcm_ima_pda           ilbc                    rv40
adpcm_ima_qt            imc                     rv60
adpcm_ima_rad           imm4                    s302m
adpcm_ima_smjpeg        imm5                    sami
adpcm_ima_ssi           indeo2                  sanm
adpcm_ima_wav           indeo3                  sbc
adpcm_ima_ws            indeo4                  scpr
adpcm_ima_xbox          indeo5                  screenpresso
adpcm_ms                interplay_acm           sdx2_dpcm
adpcm_mtaf              interplay_dpcm          sga
adpcm_n64               interplay_video         sgi
adpcm_psx               ipu                     sgirle
adpcm_psxc              jacosub                 sheervideo
adpcm_sanyo             jpeg2000                shorten
adpcm_sbpro_2           jpegls                  simbiosis_imx
adpcm_sbpro_3           jv                      sipr
adpcm_sbpro_4           kgv1                    siren
adpcm_swf               kmvc                    smackaud
adpcm_thp               lagarith                smacker
adpcm_thp_le            lead                    smc
adpcm_vima              libaom_av1              smvjpeg
adpcm_xa                libgsm                  snow
adpcm_xmd               libgsm_ms               sol_dpcm
adpcm_yamaha            libopencore_amrnb       sonic
adpcm_zork              libopencore_amrwb       sp5x
agm                     libopus                 speedhq
ahx                     libspeex                speex
aic                     libvorbis               srgc
alac                    libvpx_vp8              srt
alias_pix               libvpx_vp9              ssa
als                     loco                    stl
amrnb                   lscr                    subrip
amrwb                   m101                    subviewer
amv                     mace3                   subviewer1
anm                     mace6                   sunrast
ansi                    magicyuv                svq1
anull                   mdec                    svq3
apac                    media100                tak
ape                     metasound               targa
apng                    microdvd                targa_y216
aptx                    mimic                   tdsc
aptx_hd                 misc4                   text
apv                     mjpeg                   theora
arbc                    mjpeg_cuvid             thp
argo                    mjpeg_qsv               tiertexseqvideo
ass                     mjpegb                  tiff
asv1                    mlp                     tmv
asv2                    mmvideo                 truehd
atrac1                  mobiclip                truemotion1
atrac3                  motionpixels            truemotion2
atrac3al                movtext                 truemotion2rt
atrac3p                 mp1                     truespeech
atrac3pal               mp1float                tscc
atrac9                  mp2                     tscc2
aura                    mp2float                tta
aura2                   mp3                     twinvq
av1                     mp3adu                  txd
av1_amf                 mp3adufloat             ulti
av1_cuvid               mp3float                utvideo
av1_qsv                 mp3on4                  v210
avrn                    mp3on4float             v210x
avrp                    mpc7                    v308
avs                     mpc8                    v408
avui                    mpeg1_cuvid             v410
bethsoftvid             mpeg1video              vb
bfi                     mpeg2_cuvid             vble
bink                    mpeg2_qsv               vbn
binkaudio_dct           mpeg2video              vc1
binkaudio_rdft          mpeg4                   vc1_cuvid
bintext                 mpeg4_cuvid             vc1_qsv
bitpacked               mpegvideo               vc1image
bmp                     mpl2                    vcr1
bmv_audio               msa1                    vmdaudio
bmv_video               mscc                    vmdvideo
bonk                    msmpeg4v1               vmix
brender_pix             msmpeg4v2               vmnc
c93                     msmpeg4v3               vnull
cavs                    msnsiren                vorbis
cbd2_dpcm               msp2                    vp3
ccaption                msrle                   vp4
cdgraphics              mss1                    vp5
cdtoons                 mss2                    vp6
cdxl                    msvideo1                vp6a
cfhd                    mszh                    vp6f
cinepak                 mts2                    vp7
clearvideo              mv30                    vp8
cljr                    mvc1                    vp8_cuvid
cllc                    mvc2                    vp8_qsv
comfortnoise            mvdv                    vp9
cook                    mvha                    vp9_amf
cpia                    mwsc                    vp9_cuvid
cri                     mxpeg                   vp9_qsv
cscd                    nellymoser              vplayer
cyuv                    notchlc                 vqa
dca                     nuv                     vqc
dds                     on2avc                  vvc
derf_dpcm               opus                    vvc_qsv
dfa                     osq                     wady_dpcm
dfpwm                   paf_audio               wavarc
dirac                   paf_video               wavpack
dnxhd                   pam                     wbmp
dolby_e                 pbm                     wcmv
dpx                     pcm_alaw                webp
dsd_lsbf                pcm_bluray              webvtt
dsd_lsbf_planar         pcm_dvd                 wmalossless
dsd_msbf                pcm_f16le               wmapro
dsd_msbf_planar         pcm_f24le               wmav1
dsicinaudio             pcm_f32be               wmav2
dsicinvideo             pcm_f32le               wmavoice
dss_sp                  pcm_f64be               wmv1
dst                     pcm_f64le               wmv2
dvaudio                 pcm_lxf                 wmv3
dvbsub                  pcm_mulaw               wmv3image
dvdsub                  pcm_s16be               wnv1
dvvideo                 pcm_s16be_planar        wrapped_avframe
dxa                     pcm_s16le               ws_snd1
dxtory                  pcm_s16le_planar        xan_dpcm
dxv                     pcm_s24be               xan_wc3
eac3                    pcm_s24daud             xan_wc4
eacmv                   pcm_s24le               xbin
eamad                   pcm_s24le_planar        xbm
eatgq                   pcm_s32be               xface
eatgv                   pcm_s32le               xl
eatqi                   pcm_s32le_planar        xma1
eightbps                pcm_s64be               xma2
eightsvx_exp            pcm_s64le               xpm
eightsvx_fib            pcm_s8                  xsub
escape124               pcm_s8_planar           xwd
escape130               pcm_sga                 y41p
evrc                    pcm_u16be               ylc
exr                     pcm_u16le               yop
fastaudio               pcm_u24be               yuv4
ffv1                    pcm_u24le               zero12v
ffvhuff                 pcm_u32be               zerocodec
ffwavesynth             pcm_u32le               zlib
fic                     pcm_u8                  zmbv
fits                    pcm_vidc
flac                    pcx

Enabled encoders:
a64multi                hevc_amf                pcm_u16le
a64multi5               hevc_d3d12va            pcm_u24be
aac                     hevc_mf                 pcm_u24le
aac_mf                  hevc_nvenc              pcm_u32be
ac3                     hevc_qsv                pcm_u32le
ac3_fixed               hevc_vaapi              pcm_u8
ac3_mf                  huffyuv                 pcm_vidc
adpcm_adx               jpeg2000                pcx
adpcm_argo              jpegls                  pfm
adpcm_g722              libaom_av1              pgm
adpcm_g726              libgsm                  pgmyuv
adpcm_g726le            libgsm_ms               phm
adpcm_ima_alp           libmp3lame              png
adpcm_ima_amv           libopencore_amrnb       ppm
adpcm_ima_apm           libopenjpeg             prores
adpcm_ima_qt            libopus                 prores_aw
adpcm_ima_ssi           libspeex                prores_ks
adpcm_ima_wav           libtheora               qoi
adpcm_ima_ws            libvo_amrwbenc          qtrle
adpcm_ms                libvorbis               r10k
adpcm_swf               libvpx_vp8              r210
adpcm_yamaha            libvpx_vp9              ra_144
alac                    libwebp                 rawvideo
alias_pix               libwebp_anim            roq
amv                     libx264                 roq_dpcm
anull                   libx264rgb              rpza
apng                    libx265                 rv10
aptx                    libxvid                 rv20
aptx_hd                 ljpeg                   s302m
ass                     magicyuv                sbc
asv1                    mjpeg                   sgi
asv2                    mjpeg_qsv               smc
av1_amf                 mjpeg_vaapi             snow
av1_d3d12va             mlp                     speedhq
av1_mf                  movtext                 srt
av1_nvenc               mp2                     ssa
av1_qsv                 mp2fixed                subrip
av1_vaapi               mp3_mf                  sunrast
avrp                    mpeg1video              svq1
avui                    mpeg2_qsv               targa
bitpacked               mpeg2_vaapi             text
bmp                     mpeg2video              tiff
cfhd                    mpeg4                   truehd
cinepak                 msmpeg4v2               tta
cljr                    msmpeg4v3               ttml
comfortnoise            msrle                   utvideo
dca                     msvideo1                v210
dfpwm                   nellymoser              v308
dnxhd                   opus                    v408
dpx                     pam                     v410
dvbsub                  pbm                     vbn
dvdsub                  pcm_alaw                vc2
dvvideo                 pcm_bluray              vnull
dxv                     pcm_dvd                 vorbis
eac3                    pcm_f32be               vp8_vaapi
exr                     pcm_f32le               vp9_qsv
ffv1                    pcm_f64be               vp9_vaapi
ffvhuff                 pcm_f64le               wavpack
fits                    pcm_mulaw               wbmp
flac                    pcm_s16be               webvtt
flashsv                 pcm_s16be_planar        wmav1
flashsv2                pcm_s16le               wmav2
flv                     pcm_s16le_planar        wmv1
g723_1                  pcm_s24be               wmv2
gif                     pcm_s24daud             wrapped_avframe
h261                    pcm_s24le               xbm
h263                    pcm_s24le_planar        xface
h263p                   pcm_s32be               xsub
h264_amf                pcm_s32le               xwd
h264_d3d12va            pcm_s32le_planar        y41p
h264_mf                 pcm_s64be               yuv4
h264_nvenc              pcm_s64le               zlib
h264_qsv                pcm_s8                  zmbv
h264_vaapi              pcm_s8_planar
hdr                     pcm_u16be

Enabled hwaccels:
av1_d3d11va             hevc_nvdec              vc1_nvdec
av1_d3d11va2            hevc_vaapi              vc1_vaapi
av1_d3d12va             mjpeg_nvdec             vp8_nvdec
av1_dxva2               mjpeg_vaapi             vp8_vaapi
av1_nvdec               mpeg1_nvdec             vp9_d3d11va
av1_vaapi               mpeg2_d3d11va           vp9_d3d11va2
h263_vaapi              mpeg2_d3d11va2          vp9_d3d12va
h264_d3d11va            mpeg2_d3d12va           vp9_dxva2
h264_d3d11va2           mpeg2_dxva2             vp9_nvdec
h264_d3d12va            mpeg2_nvdec             vp9_vaapi
h264_dxva2              mpeg2_vaapi             vvc_vaapi
h264_nvdec              mpeg4_nvdec             wmv3_d3d11va
h264_vaapi              mpeg4_vaapi             wmv3_d3d11va2
hevc_d3d11va            vc1_d3d11va             wmv3_d3d12va
hevc_d3d11va2           vc1_d3d11va2            wmv3_dxva2
hevc_d3d12va            vc1_d3d12va             wmv3_nvdec
hevc_dxva2              vc1_dxva2               wmv3_vaapi

Enabled parsers:
aac                     dvdsub                  mpegaudio
aac_latm                evc                     mpegvideo
ac3                     ffv1                    opus
adx                     flac                    png
ahx                     ftr                     pnm
amr                     g723_1                  prores
apv                     g729                    prores_raw
av1                     gif                     qoi
avs2                    gsm                     rv34
avs3                    h261                    sbc
bmp                     h263                    sipr
cavsvideo               h264                    tak
cook                    hdr                     vc1
cri                     hevc                    vorbis
dca                     ipu                     vp3
dirac                   jpeg2000                vp8
dnxhd                   jpegxl                  vp9
dnxuc                   jpegxs                  vvc
dolby_e                 lcevc                   webp
dpx                     misc4                   xbm
dvaudio                 mjpeg                   xma
dvbsub                  mlp                     xwd
dvd_nav                 mpeg4video

Enabled demuxers:
aa                      ico                     pcm_f64be
aac                     idcin                   pcm_f64le
aax                     idf                     pcm_mulaw
ac3                     iff                     pcm_s16be
ac4                     ifv                     pcm_s16le
ace                     ilbc                    pcm_s24be
acm                     image2                  pcm_s24le
act                     image2_alias_pix        pcm_s32be
adf                     image2_brender_pix      pcm_s32le
adp                     image2pipe              pcm_s8
ads                     image_bmp_pipe          pcm_u16be
adx                     image_cri_pipe          pcm_u16le
aea                     image_dds_pipe          pcm_u24be
afc                     image_dpx_pipe          pcm_u24le
aiff                    image_exr_pipe          pcm_u32be
aix                     image_gem_pipe          pcm_u32le
alp                     image_gif_pipe          pcm_u8
amr                     image_hdr_pipe          pcm_vidc
amrnb                   image_j2k_pipe          pdv
amrwb                   image_jpeg_pipe         pjs
anm                     image_jpegls_pipe       pmp
apac                    image_jpegxl_pipe       pp_bnk
apc                     image_jpegxs_pipe       pva
ape                     image_pam_pipe          pvf
apm                     image_pbm_pipe          qcp
apng                    image_pcx_pipe          qoa
aptx                    image_pfm_pipe          r3d
aptx_hd                 image_pgm_pipe          rawvideo
apv                     image_pgmyuv_pipe       rcwt
aqtitle                 image_pgx_pipe          realtext
argo_asf                image_phm_pipe          redspark
argo_brp                image_photocd_pipe      rka
argo_cvg                image_pictor_pipe       rl2
asf                     image_png_pipe          rm
asf_o                   image_ppm_pipe          roq
ass                     image_psd_pipe          rpl
ast                     image_qdraw_pipe        rsd
au                      image_qoi_pipe          rso
av1                     image_sgi_pipe          rtp
avi                     image_sunrast_pipe      rtsp
avisynth                image_svg_pipe          s337m
avr                     image_tiff_pipe         sami
avs                     image_vbn_pipe          sap
avs2                    image_webp_pipe         sbc
avs3                    image_xbm_pipe          sbg
bethsoftvid             image_xpm_pipe          scc
bfi                     image_xwd_pipe          scd
bfstm                   imf                     sdns
bink                    ingenient               sdp
binka                   ipmovie                 sdr2
bintext                 ipu                     sds
bit                     ircam                   sdx
bitpacked               iss                     segafilm
bmv                     iv8                     ser
boa                     ivf                     sga
bonk                    ivr                     shorten
brstm                   jacosub                 siff
c93                     jpegxl_anim             simbiosis_imx
caf                     jv                      sln
cavsvideo               kux                     smacker
cdg                     kvag                    smjpeg
cdxl                    laf                     smush
cine                    lc3                     sol
codec2                  libgme                  sox
codec2raw               libopenmpt              spdif
concat                  live_flv                srt
dash                    lmlm4                   stl
data                    loas                    str
daud                    lrc                     subviewer
dcstr                   luodat                  subviewer1
derf                    lvf                     sup
dfa                     lxf                     svag
dfpwm                   m4v                     svs
dhav                    matroska                swf
dirac                   mca                     tak
dnxhd                   mcc                     tedcaptions
dsf                     mgsts                   thp
dsicin                  microdvd                threedostr
dss                     mjpeg                   tiertexseq
dts                     mjpeg_2000              tmv
dtshd                   mlp                     truehd
dv                      mlv                     tta
dvbsub                  mm                      tty
dvbtxt                  mmf                     txd
dxa                     mods                    ty
ea                      moflex                  usm
ea_cdata                mov                     v210
eac3                    mp3                     v210x
epaf                    mpc                     vag
evc                     mpc8                    vc1
ffmetadata              mpegps                  vc1t
filmstrip               mpegts                  vividas
fits                    mpegtsraw               vivo
flac                    mpegvideo               vmd
flic                    mpjpeg                  vobsub
flv                     mpl2                    voc
fourxm                  mpsub                   vpk
frm                     msf                     vplayer
fsb                     msnwc_tcp               vqf
fwse                    msp                     vvc
g722                    mtaf                    w64
g723_1                  mtv                     wady
g726                    musx                    wav
g726le                  mv                      wavarc
g728                    mvi                     wc3
g729                    mxf                     webm_dash_manifest
gdv                     mxg                     webvtt
genh                    nc                      wsaud
gif                     nistsphere              wsd
gsm                     nsp                     wsvqa
gxf                     nsv                     wtv
h261                    nut                     wv
h263                    nuv                     wve
h264                    obu                     xa
hca                     ogg                     xbin
hcom                    oma                     xmd
hevc                    osq                     xmv
hls                     paf                     xvag
hnm                     pcm_alaw                xwma
hxvs                    pcm_f32be               yop
iamf                    pcm_f32le               yuv4mpegpipe

Enabled muxers:
a64                     h263                    pcm_s16le
ac3                     h264                    pcm_s24be
ac4                     hash                    pcm_s24le
adts                    hds                     pcm_s32be
adx                     hevc                    pcm_s32le
aea                     hls                     pcm_s8
aiff                    iamf                    pcm_u16be
alp                     ico                     pcm_u16le
amr                     ilbc                    pcm_u24be
amv                     image2                  pcm_u24le
apm                     image2pipe              pcm_u32be
apng                    ipod                    pcm_u32le
aptx                    ircam                   pcm_u8
aptx_hd                 ismv                    pcm_vidc
apv                     ivf                     psp
argo_asf                jacosub                 rawvideo
argo_cvg                kvag                    rcwt
asf                     latm                    rm
asf_stream              lc3                     roq
ass                     lrc                     rso
ast                     m4v                     rtp
au                      matroska                rtp_mpegts
avi                     matroska_audio          rtsp
avif                    mcc                     sap
avm2                    md5                     sbc
avs2                    microdvd                scc
avs3                    mjpeg                   segafilm
bit                     mkvtimestamp_v2         segment
caf                     mlp                     smjpeg
cavsvideo               mmf                     smoothstreaming
codec2                  mov                     sox
codec2raw               mp2                     spdif
crc                     mp3                     spx
dash                    mp4                     srt
data                    mpeg1system             stream_segment
daud                    mpeg1vcd                streamhash
dfpwm                   mpeg1video              sup
dirac                   mpeg2dvd                swf
dnxhd                   mpeg2svcd               tee
dts                     mpeg2video              tg2
dv                      mpeg2vob                tgp
eac3                    mpegts                  truehd
evc                     mpjpeg                  tta
f4v                     mxf                     ttml
ffmetadata              mxf_d10                 uncodedframecrc
fifo                    mxf_opatom              vc1
filmstrip               null                    vc1t
fits                    nut                     voc
flac                    obu                     vvc
flv                     oga                     w64
framecrc                ogg                     wav
framehash               ogv                     webm
framemd5                oma                     webm_chunk
g722                    opus                    webm_dash_manifest
g723_1                  pcm_alaw                webp
g726                    pcm_f32be               webvtt
g726le                  pcm_f32le               whip
gif                     pcm_f64be               wsaud
gsm                     pcm_f64le               wtv
gxf                     pcm_mulaw               wv
h261                    pcm_s16be               yuv4mpegpipe

Enabled protocols:
async                   http                    rtmp
cache                   httpproxy               rtmpe
concat                  https                   rtmps
concatf                 icecast                 rtmpt
crypto                  ipfs_gateway            rtmpte
data                    ipns_gateway            rtmpts
dtls                    libsrt                  rtp
fd                      libssh                  srtp
ffrtmpcrypt             libzmq                  subfile
ffrtmphttp              md5                     tcp
file                    mmsh                    tee
ftp                     mmst                    tls
gopher                  pipe                    udp
gophers                 prompeg                 udplite

Enabled filters:
a3dscope                dblur                   paletteuse
aap                     dcshift                 pan
abench                  dctdnoiz                perlin
abitscope               ddagrab                 perms
acompressor             deband                  perspective
acontrast               deblock                 phase
acopy                   decimate                photosensitivity
acrossfade              deconvolve              pixdesctest
acrossover              dedot                   pixelize
acrusher                deesser                 pixscope
acue                    deflate                 pp7
addroi                  deflicker               premultiply
adeclick                deinterlace_d3d12       premultiply_dynamic
adeclip                 deinterlace_qsv         prewitt
adecorrelate            deinterlace_vaapi       procamp_vaapi
adelay                  dejudder                pseudocolor
adenorm                 delogo                  psnr
aderivative             denoise_vaapi           pullup
adrawgraph              deshake                 qp
adrc                    despill                 random
adynamicequalizer       detelecine              readeia608
adynamicsmooth          dialoguenhance          readvitc
aecho                   dilation                realtime
aemphasis               displace                remap
aeval                   doubleweave             removegrain
aevalsrc                drawbox                 removelogo
aexciter                drawbox_vaapi           repeatfields
afade                   drawgraph               replaygain
afdelaysrc              drawgrid                reverse
afftdn                  drawtext                rgbashift
afftfilt                drawvg                  rgbtestsrc
afir                    drmeter                 roberts
afireqsrc               dynaudnorm              rotate
afirsrc                 earwax                  rubberband
aformat                 ebur128                 sab
afreqshift              edgedetect              scale
afwtdn                  elbg                    scale2ref
agate                   entropy                 scale_cuda
agraphmonitor           epx                     scale_d3d11
ahistogram              eq                      scale_d3d12
aiir                    equalizer               scale_qsv
aintegral               erosion                 scale_vaapi
ainterleave             estdif                  scdet
alatency                exposure                scharr
alimiter                extractplanes           scroll
allpass                 extrastereo             segment
allrgb                  fade                    select
allyuv                  feedback                selectivecolor
aloop                   fftdnoiz                sendcmd
alphaextract            fftfilt                 separatefields
alphamerge              field                   setdar
amerge                  fieldhint               setfield
ametadata               fieldmatch              setparams
amf_capture             fieldorder              setpts
amix                    fillborders             setrange
amovie                  find_rect               setsar
amplify                 firequalizer            settb
amultiply               flanger                 sharpness_vaapi
anequalizer             floodfill               shear
anlmdn                  format                  showcqt
anlmf                   fps                     showcwt
anlms                   framepack               showfreqs
anoisesrc               framerate               showinfo
anull                   framestep               showpalette
anullsink               freezedetect            showspatial
anullsrc                freezeframes            showspectrum
apad                    fspp                    showspectrumpic
aperms                  fsync                   showvolume
aphasemeter             gblur                   showwaves
aphaser                 geq                     showwavespic
aphaseshift             gfxcapture              shuffleframes
apsnr                   gradfun                 shufflepixels
apsyclip                gradients               shuffleplanes
apulsator               graphmonitor            sidechaincompress
arealtime               grayworld               sidechaingate
aresample               greyedge                sidedata
areverse                guided                  sierpinski
arls                    haas                    signalstats
arnndn                  haldclut                signature
asdr                    haldclutsrc             silencedetect
asegment                hdcd                    silenceremove
aselect                 headphone               sinc
asendcmd                hflip                   sine
asetnsamples            highpass                siti
asetpts                 highshelf               smartblur
asetrate                hilbert                 smptebars
asettb                  histeq                  smptehdbars
ashowinfo               histogram               sobel
asidedata               hqdn3d                  spectrumsynth
asisdr                  hqx                     speechnorm
asoftclip               hstack                  split
aspectralstats          hstack_qsv              spp
asplit                  hstack_vaapi            sr_amf
ass                     hsvhold                 ssim
astats                  hsvkey                  ssim360
astreamselect           hue                     stereo3d
asubboost               huesaturation           stereotools
asubcut                 hwdownload              stereowiden
asupercut               hwmap                   streamselect
asuperpass              hwupload                subtitles
asuperstop              hwupload_cuda           super2xsai
atadenoise              hysteresis              superequalizer
atempo                  identity                surround
atilt                   idet                    swaprect
atrim                   il                      swapuv
avectorscope            inflate                 tblend
avgblur                 interlace               telecine
avsynctest              interleave              testsrc
axcorrelate             join                    testsrc2
azmq                    kerndeint               thistogram
backgroundkey           kirsch                  threshold
bandpass                lagfun                  thumbnail
bandreject              latency                 thumbnail_cuda
bass                    lenscorrection          tile
bbox                    libvmaf                 tiltandshift
bench                   life                    tiltshelf
bilateral               limitdiff               tinterlace
bilateral_cuda          limiter                 tlut2
biquad                  loop                    tmedian
bitplanenoise           loudnorm                tmidequalizer
blackdetect             lowpass                 tmix
blackframe              lowshelf                tonemap
blend                   lumakey                 tonemap_vaapi
blockdetect             lut                     tpad
blurdetect              lut1d                   transpose
bm3d                    lut2                    transpose_vaapi
boxblur                 lut3d                   treble
bwdif                   lutrgb                  tremolo
bwdif_cuda              lutyuv                  trim
cas                     mandelbrot              unpremultiply
ccrepack                maskedclamp             unsharp
cellauto                maskedmax               untile
channelmap              maskedmerge             uspp
channelsplit            maskedmin               v360
chorus                  maskedthreshold         vaguedenoiser
chromahold              maskfun                 varblur
chromakey               mcdeint                 vectorscope
chromakey_cuda          mcompand                vflip
chromanr                median                  vfrdet
chromashift             mergeplanes             vibrance
ciescope                mestimate               vibrato
codecview               mestimate_d3d12         vidstabdetect
color                   metadata                vidstabtransform
colorbalance            midequalizer            vif
colorchannelmixer       minterpolate            vignette
colorchart              mix                     virtualbass
colorcontrast           monochrome              vmafmotion
colorcorrect            morpho                  volume
colordetect             movie                   volumedetect
colorhold               mpdecimate              vpp_amf
colorize                mptestsrc               vpp_qsv
colorkey                msad                    vstack
colorlevels             multiply                vstack_qsv
colormap                negate                  vstack_vaapi
colormatrix             nlmeans                 w3fdif
colorspace              nnedi                   waveform
colorspace_cuda         noformat                weave
colorspectrum           noise                   xbr
colortemperature        normalize               xcorrelate
compand                 null                    xfade
compensationdelay       nullsink                xmedian
concat                  nullsrc                 xpsnr
convolution             oscilloscope            xstack
convolve                overlay                 xstack_qsv
copy                    overlay_cuda            xstack_vaapi
corr                    overlay_qsv             yadif
cover_rect              overlay_vaapi           yadif_cuda
crop                    owdenoise               yaepblur
cropdetect              pad                     yuvtestsrc
crossfeed               pad_cuda                zmq
crystalizer             pad_vaapi               zoneplate
cue                     pal100bars              zoompan
curves                  pal75bars               zscale
datascope               palettegen

Enabled bsfs:
aac_adtstoasc           h264_metadata           pcm_rechunk
ahx_to_mp2              h264_mp4toannexb        pgs_frame_merge
apv_metadata            h264_redundant_pps      prores_metadata
av1_frame_merge         hapqa_extract           remove_extradata
av1_frame_split         hevc_metadata           setts
av1_metadata            hevc_mp4toannexb        showinfo
chomp                   imx_dump_header         smpte436m_to_eia608
dca_core                lcevc_metadata          text2movsub
dovi_rpu                media100_to_mjpegb      trace_headers
dts2pts                 mjpeg2jpeg              truehd_core
dump_extradata          mjpega_dump_header      vp9_metadata
dv_error_marker         mov2textsub             vp9_raw_reorder
eac3_core               mpeg2_metadata          vp9_superframe
eia608_to_smpte436m     mpeg4_unpack_bframes    vp9_superframe_split
evc_frame_merge         noise                   vvc_metadata
extract_extradata       null                    vvc_mp4toannexb
filter_units            opus_metadata

Enabled indevs:
dshow                   lavfi                   vfwcap
gdigrab                 openal

Enabled outdevs:

release-essentials external libraries' versions: 

AMF v1.5.2-1-g6ec0295
aom v3.14.1-100-gb973895c4c
AviSynthPlus v3.7.5-337-gfcb9c8a2
cairo 1.18.5
ffnvcodec n13.0.19.0-5-g1b5a81a
gsm 1.0.24
lame 3.100
libgme 0.6.6
libopencore-amrnb 0.1.6
libopencore-amrwb 0.1.6
libssh 0.12.0
libtheora v1.2.0
libwebp v1.6.0-192-g3757b8a
openal-soft latest
openmpt libopenmpt-0.6.28-25-g1d77fab8
opus v1.6.1-50-g3da9f7a6
rubberband v1.8.1
SDL release-2.32.0-218-gb8b3f5ef2
speex Speex-1.2.1-51-g0589522
srt v1.5.5-9-gc39196c
VAAPI 2.24.0.
vidstab v1.1.1-24-g92bc0b0
vmaf v3.2.0-2-g60016fbd
vo-amrwbenc 0.1.3
vorbis v1.3.7-36-ge3c9861f
VPL 2.16
vpx v1.16.0-152-g91bba32d5
x264 v0.165.3223
x265 4.2-59-gb81f650
xvid v1.3.7
zeromq 4.3.5
zimg release-3.0.6-222-gb364757

