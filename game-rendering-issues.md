Here’s the expanded reference with each problem’s common causes and fixes.

### Performance issues

| Problem | Common causes | Common fixes |
|---|---|---|
| **Frame stuttering / hitching** | Shader compilation, synchronous asset loading, garbage collection, CPU spikes, uneven frame delivery | Shader precompilation, asynchronous streaming, object pooling, frame-pacing control |
| **Low frame rate** | Expensive shaders, too many draw calls, high polygon counts, excessive particles, high resolution | LOD systems, batching, instancing, culling, shader optimization, dynamic resolution |
| **Screen tearing** | Display refresh occurs midway through rendering a frame | VSync, G-Sync, FreeSync, adaptive sync, frame-rate limiting |
| **Input latency** | Frame buffering, low FPS, VSync queues, slow input processing | Higher FPS, reduced buffering, low-latency modes, immediate input sampling |
| **Loading spikes** | Assets, shaders, or world data loaded on the main thread | Asynchronous loading, background streaming, preloading, shader caches |
| **CPU bottleneck** | Physics, AI, scripting, draw-call submission, poor multithreading | Profiling, job systems, batching, spatial partitioning, multithreading |
| **GPU bottleneck** | High resolution, complex shaders, excessive overdraw, shadows, ray tracing | Resolution scaling, simpler shaders, reduced effects, LODs, upscaling |
| **Memory leaks** | Resources are created but never released | Resource tracking, cleanup systems, pooling, automated leak detection |
| **VRAM exhaustion** | Large textures, meshes, render targets, or duplicated resources | Texture streaming, compression, mipmaps, reduced texture sizes |
| **Network lag / rubber-banding** | High latency, packet loss, server overload, poor prediction | Client prediction, interpolation, lag compensation, better server tick rates |

### Geometry and depth artifacts

| Problem | Common causes | Common fixes |
|---|---|---|
| **Z-fighting** | Overlapping surfaces or insufficient depth-buffer precision | Separate surfaces, polygon offset, reverse-Z, increase near-plane distance, depth testing |
| **Clipping** | Objects cross camera clipping planes or the camera enters geometry | Adjust clipping planes, camera collision, fade nearby geometry |
| **Mesh intersections** | Incorrect placement, animation, physics, or collision boundaries | Better collision shapes, constraints, corrective animation, mesh adjustment |
| **Seams / cracks** | Unmatched vertices, different terrain LODs, floating-point differences | Vertex stitching, terrain skirts, shared edge data, consistent tessellation |
| **Backface-culling errors** | Reversed triangle winding or incorrect normals | Correct winding order, recalculate normals, use appropriate culling mode |
| **Geometry flickering** | Duplicate meshes, unstable culling, depth conflicts | Remove duplicates, correct bounds, stabilize culling, improve depth precision |
| **LOD popping** | Abrupt model-detail changes or poorly chosen transition distances | Cross-fading, dithering, geomorphing, better LOD thresholds |
| **Floating-point jitter** | Large world coordinates exceed useful numeric precision | Floating origin, camera-relative rendering, world partitioning, double precision |

### Edge, texture, and sampling artifacts

| Problem | Common causes | Common fixes |
|---|---|---|
| **Aliasing / jagged edges** | Insufficient sampling of geometry edges | MSAA, TAA, SMAA, FXAA, supersampling |
| **Temporal shimmering** | Subpixel geometry, unstable samples, inadequate temporal filtering | TAA, TSR, DLSS, FSR, stable jitter and motion vectors |
| **Texture shimmering** | Missing mipmaps or weak filtering at oblique angles | Mipmapping, trilinear filtering, anisotropic filtering |
| **Moiré patterns** | Repeating high-frequency texture details exceed pixel resolution | Mipmaps, texture filtering, anti-aliasing, reduced pattern frequency |
| **Blurry textures** | Low-resolution assets, aggressive mip selection, poor upscaling | Better textures, mip-bias adjustment, anisotropic filtering, sharpening |
| **Texture stretching** | Poor UV mapping or heavily distorted polygons | Better UV unwrapping, triplanar mapping, improved topology |
| **Texture seams** | UV islands lack padding or use mismatched normals | Texture padding, edge dilation, corrected tangents and normal maps |
| **Texture popping** | Delayed streaming or abrupt mip-level changes | Preloading, larger streaming budgets, gradual mip transitions |
| **Pixel crawling** | Fine details move between pixel samples each frame | Temporal anti-aliasing, mipmaps, reduced high-frequency detail |

### Shadows and lighting

| Problem | Common causes | Common fixes |
|---|---|---|
| **Shadow acne** | Shadow map incorrectly treats a surface as shadowing itself | Depth bias, normal bias, slope-scaled bias, higher shadow precision |
| **Peter-panning** | Excessive shadow bias separates shadows from objects | Reduce bias, improve shadow resolution, use contact shadows |
| **Jagged shadows** | Low-resolution shadow maps | Higher resolution, cascaded shadow maps, PCF, VSM, ray-traced shadows |
| **Shadow flickering** | Unstable cascades, moving samples, low precision | Stabilized cascades, temporal filtering, better bias and resolution |
| **Light leaking** | Thin walls, coarse lightmaps, weak voxel or shadow resolution | Thicker geometry, better lightmap UVs, increased resolution, ray tracing |
| **Lightmap seams** | Insufficient UV padding, separate charts, inconsistent normals | More padding, edge dilation, improved UV layout, matched normals |
| **Color bleeding** | Indirect lighting spreads too far or uses low-resolution data | GI tuning, higher-resolution lightmaps, material adjustment |
| **Banding** | Insufficient color precision in smooth gradients | HDR buffers, dithering, higher bit depth, improved tone mapping |
| **Bloom halos** | Bloom threshold is too low or intensity is excessive | Raise threshold, reduce intensity, improve HDR exposure |
| **Ambient-occlusion halos** | AO radius or depth sampling is too aggressive | Tune radius and bias, increase samples, use higher-quality AO |

### Transparency, particles, and post-processing

| Problem | Common causes | Common fixes |
|---|---|---|
| **Transparency sorting errors** | Transparent surfaces cannot be ordered correctly per pixel | Back-to-front sorting, alpha testing, depth peeling, order-independent transparency |
| **Overdraw** | Many transparent layers repeatedly shade the same pixels | Reduce particle overlap, use alpha testing, simplify effects, depth pre-pass |
| **Particle clipping** | Particles intersect walls or disappear at screen edges | Soft particles, depth fading, corrected bounding boxes |
| **Particle popping** | Incorrect effect bounds or abrupt spawning and removal | Expand bounds, fade particles, use gradual emission transitions |
| **Ghosting** | Temporal history contains outdated object positions | Correct motion vectors, history rejection, responsive TAA masks |
| **Motion-blur artifacts** | Incorrect velocity data or excessive blur strength | Correct motion vectors, clamp velocities, reduce blur |
| **Upscaling artifacts** | Poor motion vectors, unstable depth, low input resolution | Improve motion data, tune upscaler, increase render resolution |
| **Volumetric fog noise** | Too few ray-marching samples | Temporal accumulation, dithering, more samples, higher volumetric resolution |
| **Reflection artifacts** | Screen-space reflections lack off-screen information | Reflection probes, planar reflections, ray tracing, SSR fallback systems |

### Animation and physics

| Problem | Common causes | Common fixes |
|---|---|---|
| **Animation popping** | Abrupt state transitions or missing blend time | Animation blending, transition curves, inertialization |
| **Foot sliding** | Animation speed does not match character movement | Root motion, stride warping, inverse kinematics |
| **Skinning deformation** | Poor bone weights or insufficient joints | Repaint weights, add helper bones, corrective blend shapes |
| **Animation jitter** | Low update rate, networking errors, unstable IK | Interpolation, smoothing, higher update rates, stabilized IK |
| **Physics jitter** | Variable timestep, overlapping colliders, weak solver settings | Fixed timestep, interpolation, solver iterations, collision correction |
| **Tunneling** | Fast objects pass through thin colliders between updates | Continuous collision detection, raycasts, smaller physics timesteps |
| **Unstable stacking** | Inaccurate colliders, low solver iterations, mass imbalance | Better colliders, more solver iterations, sensible mass ratios |
| **Rubber-banding** | Server corrections conflict with client prediction | Reconciliation, interpolation buffers, improved prediction |

The problems are collectively called **game defects**, **rendering artifacts**, **visual artifacts**, **performance problems**, or **simulation artifacts**. Their fixes are commonly called **mitigation techniques**, **rendering techniques**, **optimization strategies**, or **pipeline solutions**.
