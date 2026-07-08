const VERTEX_SHADER = `#version 300 es
    in vec2 a_position;
    in vec2 a_texCoord;
    out vec2 v_texCoord;
    
    uniform mat3 u_transform;
    
    void main() {
        vec3 pos = u_transform * vec3(a_position, 1.0);
        gl_Position = vec4(pos.xy, 0.0, 1.0);
        v_texCoord = a_texCoord;
    }
`;

const FRAGMENT_SHADER_RGB = `#version 300 es
    precision highp float;
    
    in vec2 v_texCoord;
    out vec4 fragColor;
    
    uniform sampler2D u_texture;
    uniform float u_opacity;
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_saturation;
    
    void main() {
        vec4 color = texture(u_texture, v_texCoord);
        
        color.rgb += u_brightness;
        
        color.rgb = (color.rgb - 0.5) * u_contrast + 0.5;
        
        float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = mix(vec3(luminance), color.rgb, u_saturation);
        
        color.a *= u_opacity;
        color.rgb *= color.a;
        fragColor = color;
    }
`;

const FRAGMENT_SHADER_YUV = `#version 300 es
    precision highp float;
    
    in vec2 v_texCoord;
    out vec4 fragColor;
    
    uniform sampler2D u_yTexture;
    uniform sampler2D u_uTexture;
    uniform sampler2D u_vTexture;
    uniform float u_opacity;
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_saturation;
    uniform mat3 u_colorMatrix;
    
    void main() {
        float y = texture(u_yTexture, v_texCoord).r;
        float u = texture(u_uTexture, v_texCoord).r - 0.5;
        float v = texture(u_vTexture, v_texCoord).r - 0.5;
        
        vec3 yuv = vec3(y, u, v);
        vec3 rgb = u_colorMatrix * yuv;
        
        rgb += u_brightness;
        rgb = (rgb - 0.5) * u_contrast + 0.5;
        
        float luminance = dot(rgb, vec3(0.299, 0.587, 0.114));
        rgb = mix(vec3(luminance), rgb, u_saturation);
        
        float alpha = u_opacity;
        rgb *= alpha;
        fragColor = vec4(rgb, alpha);
    }
`;

class WebGLRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.gl = null;
        this.programRGB = null;
        this.currentProgram = null;
        
        this.quadBuffer = null;
        this.texCoordBuffer = null;
        
        this.textures = [];
        this.maxTextures = 32;
        
        this._textureCache = new Map();
        
        this._viewportWidth = 0;
        this._viewportHeight = 0;
        this._lastResizeTime = 0;
        
        this._options = options;
        this._init();
    }

    _init() {
        const gl = this.canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            preserveDrawingBuffer: this._options.preserveDrawingBuffer || false
        });
        
        if (!gl) {
            throw new Error('WebGL 2.0 not supported');
        }
        
        this.gl = gl;
        
        this._createQuadBuffers();
        this._createPrograms();
        this._resize();
        
        window.addEventListener('resize', () => this._resize());
    }

    _createQuadBuffers() {
        const gl = this.gl;
        
        const positions = new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
             1,  1
        ]);
        
        const texCoords = new Float32Array([
            0, 0,
            1, 0,
            0, 1,
            1, 1
        ]);
        
        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        
        this.texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    }

    _createPrograms() {
        const gl = this.gl;
        
        this.programRGB = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER_RGB);
        this.programYUV = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER_YUV);
        
        this._rgbLocations = {
            position: gl.getAttribLocation(this.programRGB, 'a_position'),
            texCoord: gl.getAttribLocation(this.programRGB, 'a_texCoord'),
            transform: gl.getUniformLocation(this.programRGB, 'u_transform'),
            texture: gl.getUniformLocation(this.programRGB, 'u_texture'),
            opacity: gl.getUniformLocation(this.programRGB, 'u_opacity'),
            brightness: gl.getUniformLocation(this.programRGB, 'u_brightness'),
            contrast: gl.getUniformLocation(this.programRGB, 'u_contrast'),
            saturation: gl.getUniformLocation(this.programRGB, 'u_saturation')
        };
        
        this._yuvLocations = {
            position: gl.getAttribLocation(this.programYUV, 'a_position'),
            texCoord: gl.getAttribLocation(this.programYUV, 'a_texCoord'),
            transform: gl.getUniformLocation(this.programYUV, 'u_transform'),
            yTexture: gl.getUniformLocation(this.programYUV, 'u_yTexture'),
            uTexture: gl.getUniformLocation(this.programYUV, 'u_uTexture'),
            vTexture: gl.getUniformLocation(this.programYUV, 'u_vTexture'),
            opacity: gl.getUniformLocation(this.programYUV, 'u_opacity'),
            brightness: gl.getUniformLocation(this.programYUV, 'u_brightness'),
            contrast: gl.getUniformLocation(this.programYUV, 'u_contrast'),
            saturation: gl.getUniformLocation(this.programYUV, 'u_saturation'),
            colorMatrix: gl.getUniformLocation(this.programYUV, 'u_colorMatrix')
        };
    }

    _createProgram(vsSource, fsSource) {
        const gl = this.gl;
        
        const vs = this._createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this._createShader(gl.FRAGMENT_SHADER, fsSource);
        
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(program));
            throw new Error('Program link failed');
        }
        
        return program;
    }

    _createShader(type, source) {
        const gl = this.gl;
        
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(shader));
            throw new Error('Shader compile failed');
        }
        
        return shader;
    }

    _resize() {
        const gl = this.gl;
        const canvas = this.canvas;
        
        if (!gl || !canvas) return;
        
        const canvasW = canvas.width;
        const canvasH = canvas.height;
        
        if (canvasW <= 0 || canvasH <= 0) return;
        
        if (this._viewportWidth === canvasW && this._viewportHeight === canvasH) return;
        
        this._viewportWidth = canvasW;
        this._viewportHeight = canvasH;
        this.viewportWidth = canvasW;
        this.viewportHeight = canvasH;
        
        gl.viewport(0, 0, canvasW, canvasH);
    }

    beginFrame() {
        const gl = this.gl;
        
        if (!gl) return;
        
        this._resize();
        
        if (!this._viewportWidth || !this._viewportHeight) return;
        
        gl.viewport(0, 0, this._viewportWidth, this._viewportHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    drawFrame(frame, x, y, width, height, opacity = 1.0, rotation = 0) {
        try {
            this.drawVideoFrame(frame, {
                x, y, width, height, opacity, rotation
            });
            return true;
        } catch (e) {
            console.warn('[WebGLRenderer] drawFrame failed:', e.message);
            return false;
        }
    }

    flush() {
        const gl = this.gl;
        if (gl) {
            gl.flush();
        }
    }

    /**
     * 清理临时纹理（VideoFrame 纹理），保留 video/image 元素纹理
     * @param {Array} keepKeys 要保留的纹理 key（如 video 元素的 _textureId）
     */
    clearTempTextures(keepKeys = []) {
        const gl = this.gl;
        if (!gl) return;
        
        const keepSet = new Set(keepKeys);
        const keysToDelete = [];
        
        for (const [key, texture] of this._textureCache) {
            // 保留 video_、image_ 和 canvas_ 前缀的纹理（元素纹理可复用）
            if (typeof key === 'string' && (key.startsWith('video_') || key.startsWith('image_') || key.startsWith('canvas_'))) {
                continue;
            }
            // 保留指定的 key
            if (keepSet.has(key)) continue;
            
            keysToDelete.push(key);
            try { gl.deleteTexture(texture); } catch (_) {}
        }
        
        for (const key of keysToDelete) {
            this._textureCache.delete(key);
        }
    }

    drawVideoFrame(frame, options = {}) {
        const {
            x = 0,
            y = 0,
            width = this._viewportWidth,
            height = this._viewportHeight,
            opacity = 1.0,
            brightness = 0,
            contrast = 1.0,
            saturation = 1.0,
            rotation = 0,
            scale = 1.0
        } = options;
        
        const gl = this.gl;
        const program = this.programRGB;
        const locations = this._rgbLocations;
        
        if (!gl || !program || !frame) return;
        
        const isVideoElement = frame instanceof HTMLVideoElement;
        const isImageElement = frame instanceof HTMLImageElement;
        const isCanvasElement = typeof HTMLCanvasElement !== 'undefined' && frame instanceof HTMLCanvasElement;
        const frameW = frame.codedWidth || frame.videoWidth || frame.naturalWidth || frame.width || 1920;
        const frameH = frame.codedHeight || frame.videoHeight || frame.naturalHeight || frame.height || 1080;
        
        gl.useProgram(program);
        this.currentProgram = program;
        
        this._setupAttributes(locations);
        
        const transform = this._computeTransform(x, y, width, height, rotation, scale);
        gl.uniformMatrix3fv(locations.transform, false, transform);
        
        gl.uniform1f(locations.opacity, opacity);
        gl.uniform1f(locations.brightness, brightness);
        gl.uniform1f(locations.contrast, contrast);
        gl.uniform1f(locations.saturation, saturation);
        
        let textureKey;
        if (isVideoElement) {
            if (!frame._textureId) {
                frame._textureId = 'video_' + (WebGLRenderer._textureCounter++);
            }
            textureKey = frame._textureId;
        } else if (isImageElement) {
            if (!frame._textureId) {
                frame._textureId = 'image_' + (WebGLRenderer._textureCounter++);
            }
            textureKey = frame._textureId;
        } else if (isCanvasElement) {
            if (!frame._textureId) {
                frame._textureId = 'canvas_' + (WebGLRenderer._textureCounter++);
            }
            textureKey = frame._textureId;
        } else {
            textureKey = frame.timestamp || ('frame_' + Math.random());
        }
        let texture = this._textureCache.get(textureKey);
        const isNewTexture = !texture;
        
        if (isNewTexture) {
            texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this._textureCache.set(textureKey, texture);
        }
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        const needUpload = isCanvasElement ? isNewTexture : true;
        
        if (needUpload) {
            try {
                if (isVideoElement || isImageElement || isCanvasElement) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
                } else {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frameW, frameH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    if (frame.data) {
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frameW, frameH, gl.UNSIGNED_BYTE, frame.data);
                    }
                }
            } catch (e) {
                console.warn('[WebGLRenderer] Texture upload failed:', e);
                return;
            }
        }

        // 图片/canvas使用非预乘alpha混合，视频/VideoFrame使用预乘alpha混合
        if (isImageElement || isCanvasElement) {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }

        gl.uniform1i(locations.texture, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // 恢复默认混合函数（预乘alpha）
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    drawImage(image, options = {}) {
        const {
            x = 0,
            y = 0,
            width = this._viewportWidth,
            height = this._viewportHeight,
            opacity = 1.0,
            brightness = 0,
            contrast = 1.0,
            saturation = 1.0,
            rotation = 0,
            scale = 1.0
        } = options;
        
        const gl = this.gl;
        const program = this.programRGB;
        const locations = this._rgbLocations;
        
        if (!gl || !program || !image) return;
        
        gl.useProgram(program);
        this.currentProgram = program;
        
        this._setupAttributes(locations);
        
        const transform = this._computeTransform(x, y, width, height, rotation, scale);
        gl.uniformMatrix3fv(locations.transform, false, transform);
        
        gl.uniform1f(locations.opacity, opacity);
        gl.uniform1f(locations.brightness, brightness);
        gl.uniform1f(locations.contrast, contrast);
        gl.uniform1f(locations.saturation, saturation);
        
        const imgKey = image.src || 'img_' + Math.random();
        let texture = this._textureCache.get(imgKey);
        if (!texture) {
            texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this._textureCache.set(imgKey, texture);
        }
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(locations.texture, 0);
        
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _setupAttributes(locations) {
        const gl = this.gl;
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.enableVertexAttribArray(locations.position);
        gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.enableVertexAttribArray(locations.texCoord);
        gl.vertexAttribPointer(locations.texCoord, 2, gl.FLOAT, false, 0, 0);
    }

    _computeTransform(x, y, width, height, rotation, scale) {
        const w = this._viewportWidth;
        const h = this._viewportHeight;
        
        const cx = x + width / 2;
        const cy = y + height / 2;
        
        const hw = width / 2 * scale;
        const hh = height / 2 * scale;
        
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        
        return new Float32Array([
            2 * hw * cos / w, -2 * hw * sin / h, 0,
            -2 * hh * sin / w, -2 * hh * cos / h, 0,
            2 * cx / w - 1, 1 - 2 * cy / h, 1
        ]);
    }

    _uploadRGBFrame(frame, locations) {
        const gl = this.gl;
        
        const texture = this._getTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        } catch (e) {
            const imgBitmap = this._frameToImageBitmap(frame);
            if (imgBitmap) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgBitmap);
            }
        }
        
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        
        gl.uniform1i(locations.texture, 0);
    }

    _uploadYUVFrame(frame, locations) {
        const gl = this.gl;
        
        const yPlane = frame.visibleRect ? frame.visibleRect.width * frame.visibleRect.height : 0;
        const uvPlane = yPlane / 4;
        
        const yTexture = this._getTexture();
        const uTexture = this._getTexture();
        const vTexture = this._getTexture();
        
        const yData = new Uint8Array(frame.allocationSize());
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, yTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, frame.codedWidth, frame.codedHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
        
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, uTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, frame.codedWidth / 2, frame.codedHeight / 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
        
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, vTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, frame.codedWidth / 2, frame.codedHeight / 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
        
        gl.uniform1i(locations.yTexture, 0);
        gl.uniform1i(locations.uTexture, 1);
        gl.uniform1i(locations.vTexture, 2);
        
        const bt709 = new Float32Array([
            1.0,      1.0,      1.0,
            0.0,     -0.344,    1.772,
            1.402,   -0.714,    0.0
        ]);
        gl.uniformMatrix3fv(locations.colorMatrix, false, bt709);
    }

    _frameToImageBitmap(frame) {
        try {
            return createImageBitmap(frame);
        } catch (e) {
            return null;
        }
    }

    _getTexture() {
        const gl = this.gl;
        
        if (this.textures.length < this.maxTextures) {
            const texture = gl.createTexture();
            this.textures.push(texture);
            return texture;
        }
        
        const texture = this.textures.shift();
        this.textures.push(texture);
        return texture;
    }

    endFrame() {
    }

    destroy() {
        const gl = this.gl;
        
        if (gl) {
            for (const [key, texture] of this._textureCache) {
                gl.deleteTexture(texture);
            }
            this._textureCache.clear();
            
            for (const texture of this.textures) {
                gl.deleteTexture(texture);
            }
            this.textures = [];
            
            if (this.programRGB) gl.deleteProgram(this.programRGB);
            if (this.programYUV) gl.deleteProgram(this.programYUV);
            
            if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
            if (this.texCoordBuffer) gl.deleteBuffer(this.texCoordBuffer);
        }
        
        this.programRGB = null;
        this.programYUV = null;
        this.gl = null;
    }
}

WebGLRenderer._textureCounter = 0;

window.WebGLRenderer = WebGLRenderer;
