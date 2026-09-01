const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');
let viewer, camera, infoBox, hoveredEntity;

// Gesture variables with safer defaults
let currentZoomLevel = 1.0;
let targetZoomLevel = 1.0;
const maxZoomLevel = 10.0;
const minZoomLevel = 0.1;
let smoothedLatitude = 0;
let smoothedLongitude = 0;
let smoothedZoom = 1.0;
let lastIndexPos = null;
let lastHandDetectedTime = Date.now();

// Hover state tracking
let isHoveringCountry = false;
let lastHoveredEntity = null;
let lastPickTime = 0; // scene.pick is expensive — throttle it
let hoverSpeakTimer = null; // debounce for spoken country names
const entitiesByIso = new Map(); // iso3 code -> country polygon entity

// Safety bounds for coordinates
const SAFE_LAT_MIN = -85;
const SAFE_LAT_MAX = 85;
const SAFE_LON_MIN = -180;
const SAFE_LON_MAX = 180;
const SAFE_HEIGHT_MIN = 1000000; // 1M meters minimum
const SAFE_HEIGHT_MAX = 50000000; // 50M meters maximum

// Function to validate and clamp values
function safeValue(value, min, max, defaultValue = 0) {
    if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
    return defaultValue;
    }
    return Math.max(min, Math.min(max, value));
}

// Exponential smoothing variables
const landmarkSmoothing = {
    alpha: 0.3,
    leftHand: null,
    rightHand: null
};

// Smoothing for pinch distance and position
let smoothedPinchDistance = 0;
let smoothedLeftPinchDistance = 0;
let smoothedIndexPosition = null;
let smoothedRightHandPosition = null;
let lastRightHandY = null;
const pinchSmoothing = 0.4;
const positionSmoothing = 0.25;

// Pinch detection with hysteresis, normalized by hand size so it works at any
// distance from the camera (the old fixed 0.08 threshold only worked at one
// distance). Ratio = thumbtip-to-indextip distance / wrist-to-palm distance.
const PINCH_ENTER = 0.40; // start pinching below this ratio
const PINCH_EXIT = 0.55;  // stop pinching above this ratio
let wasRightPinching = false;
let wasLeftPinching = false;

// Last camera values actually applied — lets us skip redundant setView calls
// and hand control back to the mouse whenever no gesture is active.
let lastAppliedLon = null;
let lastAppliedLat = null;
let lastAppliedZoom = null;

const maxFontSize = 35;
const minFontSize = 1;
const minHeight = 200000;
const maxHeight = 20000000;

// Layer switching functionality
const layerProviders = {
    terrain: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 18
    }),
    dark: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    maximumLevel: 18
    }),
    streets: () => new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/'
    })
};

function switchLayer(layerType) {
    try {
    // Remove existing imagery layers
    viewer.imageryLayers.removeAll();
    
    // Add new layer
    const provider = layerProviders[layerType]();
    viewer.imageryLayers.addImageryProvider(provider);
    
    // Update active state in UI
    document.querySelectorAll('.layer-option').forEach(option => {
        option.classList.remove('active');
    });
    document.querySelector(`input[value="${layerType}"]`).parentElement.classList.add('active');
    
    console.log(`Switched to ${layerType} layer`);
    } catch (error) {
    console.error(`Error switching to ${layerType} layer:`, error);
    // Fallback to terrain layer
    if (layerType !== 'terrain') {
        switchLayer('terrain');
    }
    }
}

function smoothLandmarks(landmarks, previousSmoothed, alpha) {
    if (!Array.isArray(landmarks) || landmarks.length < 21) {
    return previousSmoothed || [];
    }

    if (!previousSmoothed) {
    return landmarks.map(lm => lm ? { ...lm } : { x: 0, y: 0, z: 0 });
    }

    return landmarks.map((lm, i) => {
    if (!lm || !previousSmoothed[i]) {
        return lm ? { ...lm } : { x: 0, y: 0, z: 0 };
    }

    const x = typeof lm.x === 'number' ? lm.x : (previousSmoothed[i].x || 0);
    const y = typeof lm.y === 'number' ? lm.y : (previousSmoothed[i].y || 0);
    const z = typeof lm.z === 'number' ? lm.z : (previousSmoothed[i].z || 0);

    // Adaptive smoothing (one-euro style): heavy smoothing when the hand is
    // still (kills jitter), light smoothing when it moves fast (kills lag).
    const prev = previousSmoothed[i];
    const speed = Math.hypot(x - prev.x, y - prev.y);
    const a = Math.min(0.9, Math.max(0.15, speed * 12));

    return {
        x: prev.x * (1 - a) + x * a,
        y: prev.y * (1 - a) + y * a,
        z: prev.z * (1 - a) + z * a
    };
    });
}

function getDynamicFontSize() {
    const height = viewer.camera.positionCartographic.height;
    const t = Math.min(1, Math.max(0, (height - minHeight) / (maxHeight - minHeight)));
    // Whole pixels only: fewer distinct values means fewer label updates while zooming
    const fontSize = Math.round(minFontSize + (1 - t) * (maxFontSize - minFontSize));
    return `${fontSize}px sans-serif`;
}

function updateCanvasSize() {
    canvasElement.width = window.innerWidth;
    canvasElement.height = window.innerHeight;
}
// Resizing a canvas resets its whole state, so only do it when the window
// actually changes size (this used to run on every single frame).
window.addEventListener('resize', updateCanvasSize);

async function initWebcam() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    videoElement.srcObject = stream;
    return new Promise((resolve) => {
    videoElement.onloadedmetadata = () => {
        updateCanvasSize();
        resolve();
    };
    });
}

function initCesium() {
    // No Cesium Ion assets are used (imagery comes from ArcGIS/OSM/Carto and
    // there is no terrain), so no Ion token is needed. baseLayer: false stops
    // the viewer from requesting the default Ion imagery at startup.
    viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: false,
    baseLayerPicker: false, fullscreenButton: false, geocoder: false,
    homeButton: false, infoBox: false, sceneModePicker: false,
    selectionIndicator: false, timeline: false, navigationHelpButton: false,
    animation: false, scene3DOnly: true, skyBox: false, skyAtmosphere: false,
    shouldAnimate: true,
    contextOptions: { webgl: { alpha: true } }
    });

    viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.baseColor = Cesium.Color.TRANSPARENT;

    camera = viewer.scene.camera;
    
    // Set initial safe position
    const initialHeight = 15000000;
    camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(0, 0, initialHeight),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }
    });

    viewer.scene.screenSpaceCameraController.enableRotate = true;
    viewer.scene.screenSpaceCameraController.enableZoom = true;
    viewer.scene.screenSpaceCameraController.enableTranslate = false;
    viewer.scene.screenSpaceCameraController.enableTilt = false;

    infoBox = document.getElementById('infoBox');

    // Set up layer switching
    document.querySelectorAll('input[name="layer"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        switchLayer(e.target.value);
    });
    });

    // Load initial layer (terrain as default)
    switchLayer('terrain');

    // Load country boundaries from the local file (works offline, no
    // third-party dependency; features carry ISO3 codes as their id).
    // Antarctica is dropped: its antimeridian-spanning ring blows up Cesium's
    // rhumb-line subdivision (RangeError) and kills the whole render loop.
    fetch('countries.geo.json')
    .then(response => response.json())
    .then(geojson => {
    geojson.features = geojson.features.filter(feature => feature.id !== 'ATA');
    return Cesium.GeoJsonDataSource.load(geojson, {
        stroke: Cesium.Color.YELLOW,
        fill: Cesium.Color.TRANSPARENT, // Start with a transparent fill
        strokeWidth: 1
    });
    }).then(function(dataSource) {
    viewer.dataSources.add(dataSource);

    const entities = dataSource.entities.values;
    for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const name = entity.name || entity.properties?.NAME?.getValue() || 'Unknown';

        // Skip entities that are just labels
        if (!entity.polygon) continue;

        // Store original styling for hover effects
        entity._originalStroke = Cesium.Color.YELLOW;
        entity._originalStrokeWidth = 1;
        entity._originalFill = Cesium.Color.TRANSPARENT;

        // The GeoJSON feature id (ISO3 code, e.g. "TUR") becomes the entity id.
        const iso3 = (typeof entity.id === 'string' && /^[A-Z]{3}$/.test(entity.id)) ? entity.id : null;
        entity._iso3 = iso3;
        if (iso3) entitiesByIso.set(iso3, entity);

        // Calculate the center for the label position
        const positions = entity.polygon.hierarchy.getValue(Cesium.JulianDate.now()).positions;
        let latSum = 0, lonSum = 0, count = 0;
        for (const pos of positions) {
            const cartographic = Cesium.Cartographic.fromCartesian(pos);
            const lat = Cesium.Math.toDegrees(cartographic.latitude);
            const lon = Cesium.Math.toDegrees(cartographic.longitude);
            if (isFinite(lat) && isFinite(lon)) {
                latSum += lat;
                lonSum += lon;
                count++;
            }
        }

        if (count > 0) {
            const lat = safeValue(latSum / count, SAFE_LAT_MIN, SAFE_LAT_MAX);
            const lon = safeValue(lonSum / count, SAFE_LON_MIN, SAFE_LON_MAX);

            // Add the label as a separate entity, but link it to the polygon entity
            const labelEntity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(lon, lat),
                label: {
                    text: name,
                    font: getDynamicFontSize(),
                    fillColor: Cesium.Color.WHITE,
                    heightReference: Cesium.HeightReference.NONE,
                    outlineWidth: 0,
                    style: Cesium.LabelStyle.FILL
                },
                // Link back to the polygon entity
                _parentPolygon: entity 
            });

            // Also link from the polygon entity to the label
            entity._labelEntity = labelEntity;
        }
    }

    // Hand the country entities to the quiz/passport module
    Quiz.init(entitiesByIso);
    }).catch(error => {
    console.warn('Could not load country boundaries:', error);
    });

    // Update label fonts dynamically on zoom with error handling.
    // Only touch the ~180 label entities when the font actually changed —
    // doing it every frame was needless per-frame property churn.
    let lastLabelFont = '';
    viewer.scene.postRender.addEventListener(() => {
    try {
        const font = getDynamicFontSize();
        if (font === lastLabelFont) return;
        lastLabelFont = font;
        viewer.entities.values.forEach(entity => {
        if (entity.label) {
            entity.label.font = font;
        }
        });
    } catch (error) {
        console.warn('Error updating label fonts:', error);
    }
    });

    // Add error handling for Cesium rendering errors
    viewer.scene.renderError.addEventListener(function(scene, error) {
    console.error('Cesium rendering error:', error);
    
    // Try to recover by resetting to safe position
    try {
        smoothedLatitude = 0;
        smoothedLongitude = 0;
        smoothedZoom = 1.0;
        currentZoomLevel = 1.0;
        targetZoomLevel = 1.0;
        
        camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(0, 0, 15000000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }
        });
    } catch (recoveryError) {
        console.error('Failed to recover from rendering error:', recoveryError);
    }
    });
}

function calculateDistance(a, b) {
    if (!a || !b || typeof a.x !== 'number' || typeof a.y !== 'number' || 
        typeof b.x !== 'number' || typeof b.y !== 'number') {
    return 0;
    }
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function drawLandmarks(landmarks, isLeft, isPinching = false, isHovering = false) {
    if (!Array.isArray(landmarks) || landmarks.length < 21) return;
    try {
    const importantLandmarks = [4, 8];
    for (const i of importantLandmarks) {
        const lm = landmarks[i];
        if (!lm) continue;
        
        let radius = 6; // Default radius
        if (isPinching) {
            radius = 10;
        } else if (!isLeft && i === 8 && isHovering) {
            radius = 15; // Larger radius when hovering over country
        }
        
        canvasCtx.beginPath();
        canvasCtx.arc(lm.x * canvasElement.width, lm.y * canvasElement.height, radius, 0, 2 * Math.PI);
        
        if (isPinching) {
        canvasCtx.fillStyle = '#FF69B4';
        canvasCtx.fill();
        } else if (!isLeft && i === 8 && isHovering) {
        // Right hand index finger (landmark 8) turns pink and larger when hovering
        canvasCtx.fillStyle = '#FF69B4';
        canvasCtx.fill();
        canvasCtx.strokeStyle = '#000000';
        canvasCtx.lineWidth = 3; // Thicker stroke for larger circle
        canvasCtx.stroke();
        } else {
        canvasCtx.fillStyle = '#FFFFFF';
        canvasCtx.fill();
        canvasCtx.strokeStyle = '#000000';
        canvasCtx.lineWidth = 1;
        canvasCtx.stroke();
        }
    }

    const wrist = landmarks[0];
    if (wrist) {
        const labelY = wrist.y * canvasElement.height + 40;
        const labelX = wrist.x * canvasElement.width;
        
        canvasCtx.save();
        canvasCtx.translate(labelX, labelY);
        canvasCtx.scale(-1, 1);
        
        canvasCtx.font = '32px monospace';
        canvasCtx.fillStyle = '#FFFFFF';
        canvasCtx.strokeStyle = '#000000';
        canvasCtx.lineWidth = 3;
        canvasCtx.textAlign = 'center';
        
        const labelText = isLeft ? 'DÖNDÜR ↻' : 'ZUM ⭥';
        
        canvasCtx.strokeText(labelText, 0, 0);
        canvasCtx.fillText(labelText, 0, 0);
        
        canvasCtx.restore();
    }
    
    } catch (err) {
    console.warn('Error in drawLandmarks:', err);
    }
}

async function initMediaPipeHands() {
    const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 0,
    minDetectionConfidence: 0.4,
    minTrackingConfidence: 0.4,
    });
    await hands.initialize();
    return hands;
}

// Re-reads the actual camera position into the gesture state. Called when a
// pinch starts, so gestures continue from wherever the globe currently is
// (e.g. after mouse navigation) instead of snapping back to stale values.
function syncGestureStateFromCamera() {
    try {
        const carto = camera.positionCartographic;
        smoothedLongitude = Cesium.Math.toDegrees(carto.longitude);
        smoothedLatitude = safeValue(Cesium.Math.toDegrees(carto.latitude), SAFE_LAT_MIN, SAFE_LAT_MAX, 0);
        const zoom = safeValue(carto.height / 15000000, minZoomLevel, maxZoomLevel, 1.0);
        smoothedZoom = zoom;
        currentZoomLevel = zoom;
        targetZoomLevel = zoom;
    } catch (error) {
        console.warn('Could not sync gesture state from camera:', error);
    }
}

// Safe camera update function
function updateCameraPosition(lon, lat, zoom) {
    try {
    // Validate all inputs
    const safeLon = (typeof lon === 'number' && isFinite(lon)) ? lon : 0;
    const safeLat = safeValue(lat, SAFE_LAT_MIN, SAFE_LAT_MAX, 0);
    const safeZoom = safeValue(zoom, minZoomLevel, maxZoomLevel, 1.0);
    const safeHeight = safeValue(15000000 * safeZoom, SAFE_HEIGHT_MIN, SAFE_HEIGHT_MAX, 15000000);

    // Create destination with validated values
    const destination = Cesium.Cartesian3.fromDegrees(safeLon, safeLat, safeHeight);
    
    // Validate the destination
    if (!destination || !isFinite(destination.x) || !isFinite(destination.y) || !isFinite(destination.z)) {
        console.warn('Invalid destination calculated, skipping camera update');
        return false;
    }

    camera.setView({
        destination: destination,
        orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0
        }
    });
    
    return true;
    } catch (error) {
    console.error('Error updating camera position:', error);
    return false;
    }
}

function resetHoverStyle(entity) {
    if (entity && entity.polygon) {
        entity.polygon.material = entity._originalFill;
        entity.polygon.outline = true;
        entity.polygon.outlineColor = entity._originalStroke;
        entity.polygon.outlineWidth = entity._originalStrokeWidth;
    }
}

// Builds the info card from the locally cached country data (no per-hover
// network requests, so no out-of-order responses either).
function renderCountryCard(entity) {
    const geoName = entity.name || entity.properties?.name?.getValue() || 'Unknown';
    const data = entity._iso3 ? CountryData.get(entity._iso3) : null;
    if (!data) {
        infoBox.innerHTML = `<strong>${geoName}</strong>`;
    } else {
        const turkish = CountryData.turkishName(data);
        const currency = data.currencies ? Object.values(data.currencies)[0] : null;
        infoBox.innerHTML =
            `<img src="${data.flags.svg}" alt="Flag of ${data.name.common}" style="width:100px;border: 2px solid #000;"><br>` +
            `<strong>${data.name.common}</strong>` +
            (turkish && turkish !== data.name.common ? ` · ${turkish}` : '') +
            `<br>Başkent: ${data.capital?.[0] ?? '—'}` +
            (data.population > 0 ? `<br>Nüfus: ${data.population.toLocaleString('tr-TR')}` : '') +
            (currency ? `<br>Para birimi: ${currency.name} (${currency.symbol ?? ''})` : '') +
            `<br>Bölge: ${Quiz.regionTr(data.region, data.subregion)}`;
    }
    infoBox.style.display = 'block';
    // Pronounce the country name while browsing (quiz speaks its own prompts).
    // Debounced: sweeping the finger across many countries used to start and
    // cancel speech constantly, which made it stuttery and unintelligible.
    clearTimeout(hoverSpeakTimer);
    if (!Quiz.isActive) {
        const spokenName = data ? data.name.common : geoName;
        hoverSpeakTimer = setTimeout(() => Effects.speak(spokenName), 600);
    }
}

function handleCountryHover(landmarks) {
    // If no landmarks are provided, clear any existing hover effect and hide the info box.
    if (!landmarks || landmarks.length < 9) {
        resetHoverStyle(lastHoveredEntity);
        lastHoveredEntity = null;
        infoBox.style.display = 'none';
        isHoveringCountry = false;
        clearTimeout(hoverSpeakTimer);
        Quiz.onHover(null);
        return;
    }

    const indexTip = landmarks[8];
    const screenX = (1 - indexTip.x) * canvasElement.width;
    const screenY = indexTip.y * canvasElement.height;
    // The quiz tracks pointer motion every frame (its dwell only charges
    // while the finger holds still), so notify before the pick throttle.
    Quiz.notifyPointer(screenX, screenY);

    // scene.pick does a GPU readback — ~10 checks per second is plenty.
    const now = performance.now();
    if (now - lastPickTime < 100) return;
    lastPickTime = now;

    pickAndHover(new Cesium.Cartesian2(screenX, screenY));
}

// Shared hover logic for both the finger pointer and the mouse fallback.
function pickAndHover(screenPosition) {
    const pickedObject = viewer.scene.pick(screenPosition);

    let currentEntity = null;
    if (pickedObject && pickedObject.id) {
        // If we picked a label, get its parent polygon entity
        if (pickedObject.id._parentPolygon) {
            currentEntity = pickedObject.id._parentPolygon;
        } else {
            currentEntity = pickedObject.id;
        }
    }

    if (currentEntity && currentEntity.polygon) {
        isHoveringCountry = true;

        // If the pointer is over a new country, update the info.
        if (currentEntity !== lastHoveredEntity) {
            resetHoverStyle(lastHoveredEntity);
            lastHoveredEntity = currentEntity;

            // Apply pink hover styling
            currentEntity.polygon.material = Cesium.Color.HOTPINK.withAlpha(0.3);
            currentEntity.polygon.outline = true;
            currentEntity.polygon.outlineColor = Cesium.Color.HOTPINK;
            currentEntity.polygon.outlineWidth = 3; // Thicker border

            renderCountryCard(currentEntity);
            Quiz.onHover(currentEntity._iso3 || null);
        }
    } else {
        isHoveringCountry = false;
        resetHoverStyle(lastHoveredEntity);
        lastHoveredEntity = null;
        infoBox.style.display = 'none';
        clearTimeout(hoverSpeakTimer);
        Quiz.onHover(null);
    }
}

function onResults(results) {
    try {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    const now = Date.now();
    let rightDetected = false;
    let leftDetected = false;
    let rightHandSeen = false;

    if (!results || !results.multiHandLandmarks || !Array.isArray(results.multiHandLandmarks)) {
        return;
    }

    if (results.multiHandLandmarks.length > 0) {
        lastHandDetectedTime = now;

        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            try {
            const rawLandmarks = results.multiHandLandmarks[i];
            
            if (!Array.isArray(rawLandmarks) || rawLandmarks.length < 21) {
                console.warn(`Invalid landmarks for hand ${i}:`, rawLandmarks);
                continue;
            }

            if (!results.multiHandedness || !results.multiHandedness[i] || !results.multiHandedness[i].label) {
                console.warn(`Invalid handedness data for hand ${i}`);
                continue;
            }

            const isLeft = results.multiHandedness[i].label === 'Left';

            let smoothedLandmarks;
            if (isLeft) {
                landmarkSmoothing.leftHand = smoothLandmarks(
                    rawLandmarks, 
                    landmarkSmoothing.leftHand, 
                    landmarkSmoothing.alpha
                );
                smoothedLandmarks = landmarkSmoothing.leftHand;
            } else {
                landmarkSmoothing.rightHand = smoothLandmarks(
                    rawLandmarks, 
                    landmarkSmoothing.rightHand, 
                    landmarkSmoothing.alpha
                );
                smoothedLandmarks = landmarkSmoothing.rightHand;
            }

            if (!smoothedLandmarks || smoothedLandmarks.length < 21) {
                console.warn(`Invalid smoothed landmarks for hand ${i}`);
                continue;
            }

            let isPinching = false;

            if (!isLeft) {
                const thumb = smoothedLandmarks[4];
                const index = smoothedLandmarks[8];
                
                if (!thumb || !index) {
                    console.warn('Missing thumb or index finger landmark for right hand');
                    continue;
                }

                const rawPinch = calculateDistance(thumb, index);
                // Normalize by hand size so pinch works at any camera distance
                const handScale = Math.max(0.02, calculateDistance(smoothedLandmarks[0], smoothedLandmarks[9]));
                smoothedPinchDistance = smoothedPinchDistance * (1 - pinchSmoothing) + (rawPinch / handScale) * pinchSmoothing;
                const rightPinchNow = wasRightPinching
                    ? smoothedPinchDistance < PINCH_EXIT
                    : smoothedPinchDistance < PINCH_ENTER;

                if (rightPinchNow) {
                    isPinching = true;
                    const indexTip = smoothedLandmarks[8];

                    if (!indexTip || typeof indexTip.x !== 'number' || typeof indexTip.y !== 'number') {
                        console.warn('Invalid index tip position for zoom');
                        continue;
                    }

                    if (!wasRightPinching) {
                        // Pinch just started: continue from the camera's actual position
                        syncGestureStateFromCamera();
                    }

                    if (!smoothedRightHandPosition) {
                        smoothedRightHandPosition = { x: indexTip.x, y: indexTip.y };
                    } else {
                        smoothedRightHandPosition.x = smoothedRightHandPosition.x * (1 - positionSmoothing) + indexTip.x * positionSmoothing;
                        smoothedRightHandPosition.y = smoothedRightHandPosition.y * (1 - positionSmoothing) + indexTip.y * positionSmoothing;
                    }

                    if (lastRightHandY !== null) {
                        const deltaY = smoothedRightHandPosition.y - lastRightHandY;
                        // Multiplicative zoom: the same hand movement changes the
                        // height by the same *percentage* at any zoom level, which
                        // feels uniform (additive zoom was jumpy when zoomed in).
                        const newTargetZoom = targetZoomLevel * Math.exp(deltaY * 2.5);
                        targetZoomLevel = safeValue(newTargetZoom, minZoomLevel, maxZoomLevel, targetZoomLevel);
                    }
                    lastRightHandY = smoothedRightHandPosition.y;
                    rightDetected = true;
                } else {
                    lastRightHandY = null;
                    smoothedRightHandPosition = null;
                }
                wasRightPinching = rightPinchNow;

                // Always call handleCountryHover when the right hand is visible
                rightHandSeen = true;
                handleCountryHover(smoothedLandmarks);
            } else {
                const indexTip = smoothedLandmarks[8];
                const thumbTip = smoothedLandmarks[4];
                
                if (!indexTip || !thumbTip) {
                    console.warn('Missing index or thumb landmark for left hand');
                    continue;
                }

                const rawLeftPinch = calculateDistance(indexTip, thumbTip);
                const leftHandScale = Math.max(0.02, calculateDistance(smoothedLandmarks[0], smoothedLandmarks[9]));
                smoothedLeftPinchDistance = smoothedLeftPinchDistance * (1 - pinchSmoothing) + (rawLeftPinch / leftHandScale) * pinchSmoothing;
                const leftPinchNow = wasLeftPinching
                    ? smoothedLeftPinchDistance < PINCH_EXIT
                    : smoothedLeftPinchDistance < PINCH_ENTER;

                if (leftPinchNow) {
                    isPinching = true;
                    if (typeof indexTip.x !== 'number' || typeof indexTip.y !== 'number') {
                        console.warn('Invalid index tip coordinates for navigation');
                        continue;
                    }

                    if (!wasLeftPinching) {
                        // Pinch just started: continue from the camera's actual position
                        syncGestureStateFromCamera();
                    }

                    if (!smoothedIndexPosition) {
                        smoothedIndexPosition = { x: indexTip.x, y: indexTip.y };
                    } else {
                        smoothedIndexPosition.x = smoothedIndexPosition.x * (1 - positionSmoothing) + indexTip.x * positionSmoothing;
                        smoothedIndexPosition.y = smoothedIndexPosition.y * (1 - positionSmoothing) + indexTip.y * positionSmoothing;
                    }

                    if (lastIndexPos) {
                        const deltaX = smoothedIndexPosition.x - lastIndexPos.x;
                        const deltaY = smoothedIndexPosition.y - lastIndexPos.y;

                        // Add bounds checking for deltas
                        if (typeof deltaX === 'number' && typeof deltaY === 'number' &&
                            Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 &&
                            isFinite(deltaX) && isFinite(deltaY)) {

                            // Rotation speed scales with zoom, so panning stays
                            // precise when zoomed in and fast when zoomed out.
                            const baseRotationSpeed = 240;
                            const zoomFactor = Math.max(0.05, Math.min(2.0, smoothedZoom));
                            const rotationSpeed = baseRotationSpeed * zoomFactor;

                            const newLon = smoothedLongitude + deltaX * rotationSpeed;
                            const newLat = smoothedLatitude + deltaY * (rotationSpeed * 0.5);

                            smoothedLongitude = newLon;
                            smoothedLatitude = safeValue(newLat, SAFE_LAT_MIN, SAFE_LAT_MAX, smoothedLatitude);
                        }
                    }
                    lastIndexPos = { x: smoothedIndexPosition.x, y: smoothedIndexPosition.y };
                    leftDetected = true;
                } else {
                    lastIndexPos = null;
                    smoothedIndexPosition = null;
                }
                wasLeftPinching = leftPinchNow;
            }

            // Draw landmarks with hover state for right hand
            drawLandmarks(smoothedLandmarks, isLeft, isPinching, !isLeft && isHoveringCountry);
            } catch (handError) {
            console.warn(`Error processing hand ${i}:`, handError);
            continue;
            }
        }
        // The hover (and the quiz dwell) must clear when the pointing hand
        // leaves the frame, even if the other hand is still visible.
        if (!rightHandSeen) {
            handleCountryHover(null);
        }
    } else {
        landmarkSmoothing.leftHand = null;
        landmarkSmoothing.rightHand = null;
        smoothedIndexPosition = null;
        smoothedRightHandPosition = null;
        lastRightHandY = null;
        handleCountryHover(null); // Clear hover when no hands are detected
    }

    // Update zoom with validation
    if (now - lastHandDetectedTime < 500) {
        if (typeof targetZoomLevel === 'number' && isFinite(targetZoomLevel)) {
        const newZoom = currentZoomLevel + (targetZoomLevel - currentZoomLevel) * 0.12;
        currentZoomLevel = safeValue(newZoom, minZoomLevel, maxZoomLevel, currentZoomLevel);
        smoothedZoom = currentZoomLevel;
        }
    }

    // Update camera position with validation — but only when the gesture state
    // actually changed. Skipping redundant setView calls avoids per-frame
    // camera churn and leaves the mouse in control whenever no pinch is active.
    if (typeof smoothedLongitude === 'number' && typeof smoothedLatitude === 'number' &&
        typeof smoothedZoom === 'number' && isFinite(smoothedLongitude) &&
        isFinite(smoothedLatitude) && isFinite(smoothedZoom)) {

        const changed = lastAppliedLon === null ||
            Math.abs(smoothedLongitude - lastAppliedLon) > 1e-4 ||
            Math.abs(smoothedLatitude - lastAppliedLat) > 1e-4 ||
            Math.abs(smoothedZoom - lastAppliedZoom) > 1e-4;
        if (changed && updateCameraPosition(smoothedLongitude, smoothedLatitude, smoothedZoom)) {
            lastAppliedLon = smoothedLongitude;
            lastAppliedLat = smoothedLatitude;
            lastAppliedZoom = smoothedZoom;
        }
    }
    
    } catch (error) {
    console.error('Error in onResults:', error);
    
    // Reset to safe state on error
    landmarkSmoothing.leftHand = null;
    landmarkSmoothing.rightHand = null;
    smoothedIndexPosition = null;
    smoothedRightHandPosition = null;
    lastIndexPos = null;
    lastRightHandY = null;
    
    // Reset position values to safe defaults
    smoothedLatitude = safeValue(smoothedLatitude, SAFE_LAT_MIN, SAFE_LAT_MAX, 0);
    smoothedLongitude = (typeof smoothedLongitude === 'number' && isFinite(smoothedLongitude)) ? smoothedLongitude : 0;
    smoothedZoom = safeValue(smoothedZoom, minZoomLevel, maxZoomLevel, 1.0);
    currentZoomLevel = smoothedZoom;
    targetZoomLevel = smoothedZoom;
    isHoveringCountry = false;
    }
}

// Mouse fallback: when no hands have been seen recently, the mouse pointer
// hovers countries too. The globe (and the quiz) stays fully usable on
// devices without a camera.
function initMouseFallback() {
    document.getElementById('cesiumContainer').addEventListener('mousemove', (event) => {
        if (Date.now() - lastHandDetectedTime < 1000) return; // hands take priority
        Quiz.notifyPointer(event.clientX, event.clientY);
        const now = performance.now();
        if (now - lastPickTime < 100) return;
        lastPickTime = now;
        pickAndHover(new Cesium.Cartesian2(event.clientX, event.clientY));
    });
}

async function startApp() {
    CountryData.load(); // fetch country metadata once, in the background
    updateCanvasSize();

    // The globe must come up even if the camera fails — mouse control still works.
    try {
        initCesium();
        initMouseFallback();
    } catch (error) {
        console.error('Error starting Cesium:', error);
        alert('Failed to start the 3D globe. Please refresh the page.');
        return;
    }

    try {
        await initWebcam();
        const hands = await initMediaPipeHands();
        hands.onResults(onResults);

        const cameraUtils = new Camera(videoElement, {
            onFrame: async () => {
                try {
                    await hands.send({ image: videoElement });
                } catch (error) {
                    console.warn('Error sending frame to MediaPipe:', error);
                }
            },
            width: 1280, height: 720
        });
        cameraUtils.start();
    } catch (error) {
        console.error('Camera unavailable, continuing with mouse control:', error);
        const instructions = document.querySelector('#instructions .content');
        if (instructions) {
            instructions.innerHTML =
                '<div class="section"><div class="control-item">KAMERA KULLANILAMIYOR (meşgul ya da engelli)</div>' +
                '<div class="control-item">Fareyi kullan: sürükle = döndür, tekerlek = zum, ülkenin üzerine gel = bilgi</div></div>';
        }
    }
}

// Add window error handler
window.addEventListener('error', function(event) {
    console.error('Global error:', event.error);
    
    // If it's a Cesium-related error, try to reset the camera
    if (event.error && event.error.message && event.error.message.includes('Array')) {
    try {
        smoothedLatitude = 0;
        smoothedLongitude = 0;
        smoothedZoom = 1.0;
        currentZoomLevel = 1.0;
        targetZoomLevel = 1.0;
        isHoveringCountry = false;
        
        if (camera) {
        updateCameraPosition(0, 0, 1.0);
        }
    } catch (resetError) {
        console.error('Failed to reset after global error:', resetError);
    }
    }
});

startApp();