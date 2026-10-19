// Configuração comum do fabric para toque.
import * as fabric from 'fabric';

fabric.FabricObject.customProperties = ['kind', 'fieldName', 'editId', 'boxKey'];
// O fabric 7 usa o centro como origem; aqui trabalhamos com o canto superior esquerdo (como no desktop)
fabric.FabricObject.ownDefaults.originX = 'left';
fabric.FabricObject.ownDefaults.originY = 'top';
Object.assign(fabric.InteractiveFabricObject.ownDefaults, {
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#0b63d8',
  borderColor: '#0b63d8',
  cornerStyle: 'circle',
  cornerSize: 14,
  touchCornerSize: 36,
  borderScaleFactor: 1.5,
  padding: 4,
});

// Linha de base do texto dentro de um IText (ver Text._renderTextCommon do fabric)
const TEXT_DEFAULTS = fabric.IText.getDefaults();
export const LINE_MULT = TEXT_DEFAULTS._fontSizeMult;
export const TEXT_BASELINE_RATIO = TEXT_DEFAULTS._fontSizeMult * (1 - TEXT_DEFAULTS._fontSizeFraction);

export { fabric };
